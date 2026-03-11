---
title: "sync.Once 在 eino 流复制里的妙用：一次读，多路看"
date: 2026-03-10T10:00:00+08:00
description: "`github.com/cloudwego/eino` 源码时，对 `sync.Once` 与流复制设计的一次系统复盘"
categories: ["Eino"]
tags: ["Agent"]
series: ["Eino实践"]
draft: false
---


## sync.Once 在 eino 流复制里的妙用：一次读，多路看

这篇文档是我在阅读 `github.com/cloudwego/eino` 源码时，对 `sync.Once` 与流复制设计的一次系统复盘。

---

## 1. 问题背景：流式 LLM 输出如何「一份数据，多路消费」？

在 eino 的 ReAct Agent 里，ChatModel 使用流式输出：

- 从 LLM 得到的是一个 `*schema.StreamReader[*schema.Message]`
- 框架既需要：
  - **一条分支流**：提前扫一遍，看这个流里有没有 `tool_calls`（`StreamToolCallChecker`）
  - **一条业务流**：正常把整个消息流传给后续 graph（也就是我最终看到的输出）

这就是典型的「**单生产者，多消费者（fan-out）**」问题：

- 生产者：LLM 原始流
- 消费者：
  - child\[0]：专门用来检查是否有工具调用
  - child\[1]：最终输出给用户的那条流

要求是：

1. 原始流里的每个 chunk **只能读一次**（否则会乱序 / 重复 / 性能浪费）
2. 每个 child 都能「独立前进」，互不干扰
3. 多个 child 读到的同一位置的 chunk 必须是一致的

eino 的实现方案是：**用链表缓存 chunk + `sync.Once` 懒加载 + parent/child 流复制**。

---

## 2. 基础回顾：sync.Once 到底保证了什么？

`sync.Once` 的核心语义只有一句话：

> 在并发环境下，某个函数只会被执行一次，后续所有调用都会直接返回。

典型用法：

```go
var once sync.Once

func Init() {
	once.Do(func() {
		// 只需要执行一次的初始化逻辑
	})
}
```

注意两点：

- **Once 的作用域取决于它的「存放位置」**：
  - 放在全局变量上：整个进程生命周期只会执行一次
  - 放在某个结构体字段上：每个结构体实例各自「一次」
- Once 不区分「成功/失败」：只要 `Do` 里的函数被调用过一次，就算完成了  
  如果要失败重试，不能直接依赖 `Once`。

很多人下意识会把 `sync.Once` 理解成「全局只一次」，但在 eino 这个设计里，它是「**每个节点（slot）一次**」，这是理解后面设计的关键。

---

## 3. 核心结构：parent / child / 链表节点

先看简化后的几个关键类型（删掉了泛型细节）：

```go
type cpStreamElement[T any] struct {
	once sync.Once
	next *cpStreamElement[T]
	item streamItem[T] // {chunk, err}
}

type parentStreamReader[T any] struct {
	sr            *StreamReader[T]      // 原始 LLM 流
	subStreamList []*cpStreamElement[T] // 每个 child 当前所在的「节点指针」
}

type childStreamReader[T any] struct {
	parent *parentStreamReader[T]
	index  int // child 在 subStreamList 里的下标
}
```

直观理解：

- **原始流 `sr`**：真正从 LLM 读取 chunk 的地方，只能有一个消费者。
- **链表节点 `cpStreamElement`**：
  - 每个节点对应「流上的一个位置」
  - 有自己的 `sync.Once` 和 `item`（缓存的 chunk）
- **parentStreamReader**：
  - 持有原始流 `sr`
  - 用一条链表把所有 `cpStreamElement` 串起来
  - `subStreamList[i]` 记录第 i 个 child 当前在链表上的位置
- **childStreamReader**：
  - 自己不直接碰原始流
  - 每次 `Recv()` 都委托 parent：`parent.peek(index)`

可以类比成：

> 原始流 = 数据源  
> parent = 缓存管理器 + 路由  
> child = 只会调用「缓存管理器」的读者

---

## 4. 流复制入口：StreamReader.Copy(n)

多路消费是通过 `StreamReader.Copy(n)` 实现的：

```go
func (sr *StreamReader[T]) Copy(n int) []*StreamReader[T] {
	if n < 2 {
		return []*StreamReader[T]{sr}
	}

	if sr.typ == readerTypeArray {
		// 数组类型的特殊处理，这里略过
	}

	return copyStreamReaders[T](sr, n)
}
```

`copyStreamReaders` 创建一个 parent + N 个 child：

```go
func copyStreamReaders[T any](sr *StreamReader[T], n int) []*StreamReader[T] {
	cpsr := &parentStreamReader[T]{
		sr:            sr,
		subStreamList: make([]*cpStreamElement[T], n),
	}

	// 初始化：所有 child 的起点指向同一个空尾节点
	elem := &cpStreamElement[T]{}
	for i := range cpsr.subStreamList {
		cpsr.subStreamList[i] = elem
	}

	// 为每个 child 创建一个新的 StreamReader
	ret := make([]*StreamReader[T], n)
	for i := range ret {
		ret[i] = &StreamReader[T]{
			csr: &childStreamReader[T]{
				parent: cpsr,
				index:  i, // child[0] / child[1] 就在这里编号
			},
			typ: readerTypeChild,
		}
	}
	return ret
}
```

对应到 ReAct Agent 的使用场景，大致是：

```go
// 模型输出一个流
srModel := chatModel.Stream(...)

// 分成两路
srs := srModel.Copy(2)
srForChecker := srs[0] // child[0]：给 StreamToolCallChecker 用
srForGraph   := srs[1] // child[1]：给后续 graph（最终输出）用
```

---

## 5. 关键函数 peek：Once + 链表 + 懒加载

所有 child 最终都会走到同一个地方：`parent.peek(idx)`。

```go
func (p *parentStreamReader[T]) peek(idx int) (t T, err error) {
	elem := p.subStreamList[idx]
	if elem == nil {
		// child 已经关闭，再读就是错误
		return t, ErrRecvAfterClosed
	}

	// 第一次有「这个 child」想读这个位置时，
	// 用 once.Do 从原始流拉一块数据进来
	elem.once.Do(func() {
		t, err = p.sr.Recv()                        // 从原始流读一次
		elem.item = streamItem[T]{chunk: t, err: err}
		if err != io.EOF {
			elem.next = &cpStreamElement[T]{}       // 为下一块准备新节点
			p.subStreamList[idx] = elem.next       // 这个 child 的指针前进到 next
		}
	})

	// 一旦 once 执行过，这个 elem.item 就是稳定的缓存
	t = elem.item.chunk
	err = elem.item.err
	if err != io.EOF {
		p.subStreamList[idx] = elem.next           // 再次前进指针
	}
	return t, err
}
```

这里有两个容易混淆的点，需要分开看：

### 5.1 「每个 elem 一个 Once」，不是「整个流一个 Once」

链表大致可以画成这样：

```text
elem0 -- elem1 -- elem2 -- elem3 -- ...
  |        |        |        |
 once0   once1   once2   once3
```

- 每个 `cpStreamElement` 自己有一个 `sync.Once`
- 对于「整条流」来说，会依次触发：  
  `elem0.once.Do(...)` → 读第 0 个 chunk  
  `elem1.once.Do(...)` → 读第 1 个 chunk  
  `elem2.once.Do(...)` → 读第 2 个 chunk  
  ……
- 对于「单个 elem」来说，它的 `once` **确实只执行一次**，保证「这个位置的 chunk 只从原始流读一次」。

所以可以把它理解成：

> **Once per slot**，而不是 Once per stream。

### 5.2 child\[0] / child\[1] 是怎么独立前进的？（含初始状态示意）

这里如果只用「ptr0/ptr1」那种抽象图，很容易把 child 和 elem 搞混（我一开始也是）。  
我们先把**初始状态画清楚**，再看「谁先动」、「谁后动」的时序。

#### 5.2.1 初始状态：两条指针指向同一个 elem0

在 `copyStreamReaders` 里有这样一段逻辑：

```go
elem := &cpStreamElement[T]{}

for i := range cpsr.subStreamList {
    cpsr.subStreamList[i] = elem  // ← 多个 child 的起点指向同一个 elem
}
```

可以画成更贴近真实结构的图：

```text
原始流 sr
  │
  ▼
parentStreamReader
  ├─ subStreamList[0] ─┐
  └─ subStreamList[1] ─┘
                         └─→ elem0 { once, item=空, next=nil }
```

也就是说：

- 刚 `Copy(2)` 完成时，**child\[0] 和 child\[1] 的“当前位置”其实是同一个 elem0**；
- elem0 里面的：
  - `once` 还没执行
  - `item` 还是空
  - `next` 也是 nil

#### 5.2.2 第一次读取：谁先读，谁触发 elem0.once

假设 `child[0]` 先调用 `Recv()`，会走到：

```go
func (csr *childStreamReader[T]) recv() (T, error) {
    return csr.parent.peek(csr.index) // index = 0
}
```

于是进入：

```go
func (p *parentStreamReader[T]) peek(idx int) (t T, err error) {
    elem := p.subStreamList[idx] // 对 child[0] 来说，就是 elem0

    elem.once.Do(func() {
        t, err = p.sr.Recv()                  // 从原始流读第 0 个 chunk
        elem.item = streamItem[T]{chunk: t, err: err}
        if err != io.EOF {
            elem.next = &cpStreamElement[T]{} // 准备 elem1
            p.subStreamList[idx] = elem.next
        }
    })

    t = elem.item.chunk
    err = elem.item.err
    if err != io.EOF {
        p.subStreamList[idx] = elem.next
    }
    return t, err
}
```

此时的效果是：

- 从原始流读出 **第 0 个 chunk**，写入 `elem0.item`
- 为下一块准备 `elem1`
- `subStreamList[0]` 前进到 `elem1`
- `subStreamList[1]` 仍然指向 `elem0`

状态可以画成：

```text
subStreamList[0] → elem1 { once1, item=空, next=nil }
subStreamList[1] → elem0 { once0(已执行), item=chunk0, next=elem1 }
原始流 sr       → 下一个待读的是 chunk1
```

接着如果 `child[1]` 再调用 `Recv()`：

- 它的 `idx = 1`，仍然从 `subStreamList[1]` 读到 **elem0**
- 由于 `elem0.once` 已经执行过：
  - `once.Do` 里不会再去读原始流
  - 直接复用 `elem0.item`（也就是 chunk0）
- 然后 `subStreamList[1]` 也会前进到 `elem1`

此时两条子流的「当前位置」又重新对齐到同一个节点：

```text
subStreamList[0] → elem1 { once1, item=空, next=nil }
subStreamList[1] → elem1 { once1, item=空, next=nil }
```

#### 5.2.3 后续时序：slot 级别懒加载 + 各自节奏前进

如果继续往后看，会重复类似的过程：

1. 某个 child 首次抵达某个 elemX，触发 `elemX.once.Do`：
   - 从原始流读第 X 个 chunk
   - 填充 `elemX.item`
   - 挂上 `elemX.next = elem(X+1)`
2. 之后其它 child 抵达同一个 elemX 时：
   - `elemX.once` 不再执行
   - 直接读取已经缓存好的 `elemX.item`
3. 每个 child 在 `peek(idx)` return 之后，都会把自己的 `subStreamList[idx]` 前进到 `elem.next`，因此：
   - 各自有独立的「当前位置」
   - 但底层每个位置的 chunk 只从原始流读取 **一次**

从更宏观的角度看：

- **数据只读一次**：每个 slot（elemX）只会有一次 `sr.Recv()` 调用
- **多路独立消费**：每个 child 有自己的游标（`subStreamList[idx]`）
- **数据一致**：不同 child 在访问同一 slot 时，看到同一个 `elemX.item`

这比简单的「ptr0 / ptr1」抽象更贴近真实实现，也更不容易混淆 child 和 elem 的角色。

---

## 6. 套回 ReAct Agent 场景：为什么 Checker 不会「吃掉」我的输出？

结合上面的结构，再看 ReAct Agent 的一个典型流转：

1. ChatModel 第一次流式输出：
   - 开始时输出一些自然语言前缀（比如「我来帮您查询上海天气情况。」）
   - 后面输出 `tool_calls`，让 Agent 去调用工具
2. 框架对这个流调用 `Copy(2)`：
   - child\[0] → `StreamToolCallChecker` 使用，用来「扫是否有 tool_calls」
   - child\[1] → 真正交给 graph（包括最终返回给用户的 `agent.Stream()`）
3. `StreamToolCallChecker` 内部 while 调用 `srForChecker.Recv()`：
   - 底层走的是 `peek(0)`
   - 负责把「第一次模型输出」这条流里的 chunk 懒加载进链表缓存
4. 后续 graph（包括最终输出给终端的流）使用的是 `srForGraph`：
   - 底层走的是 `peek(1)`
   - 复用同一条链表缓存，不会因为 checker 先读过就「吃掉」数据

所以：

- 你在日志里看不到 `tool_calls` 的 chunk，是因为这些 chunk 在「第一次模型输出」阶段被 checker 那条 child 消费掉了；
- 你最终拿到的 `agent.Stream()` 是「工具调用之后，模型第二次输出」的流；
- 但两者在底层读原始流时，都通过 parent + 链表 + `sync.Once` 做了安全的共享和 fan-out。

---

## 7. 可借鉴的模式总结

这个设计提供了一个非常通用、优雅的并发模式，可以在自己的项目里直接借鉴：

- **场景**：单一流/数据源，需要被多个下游独立消费，但：
  - 不希望/不能重复从源头读取
  - 各个消费者读取节奏不同
  - 希望「懒加载」而不是一次性读完
- **模式**：
  1. 定义一个「父读取器」，握住真实数据源
  2. 用链表/数组等结构缓存已经读取过的位置
  3. 对每个位置使用 `sync.Once` 做懒加载：「第一个访问这个位置的消费者负责把数据拉进缓存」
  4. 为每个消费者维护独立的「当前位置指针」，按需推进

一句话概括：

> **用 `sync.Once` 把「一次性初始化」这个语义，从「全局」粒度下放到「位置(slot)」粒度，就可以在流式场景下优雅地实现「一次读，多路看」。**

