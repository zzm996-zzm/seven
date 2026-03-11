---
title: "Go map 底层原理：从 hmap 到 bmap 的完整解析"
date: 2026-03-01T10:00:00+08:00
description: "深入 Go runtime 源码，彻底搞清楚 map 的哈希碰撞、扩容策略和并发安全边界"
categories: ["Deep Dive"]
tags: ["Go", "Runtime", "源码解析"]
series: ["Go 源码解析"]
draft: false
---

Go 的 `map` 是日常开发中最常用的数据结构之一，但它底层究竟是怎么运作的？为什么不支持并发读写？扩容时发生了什么？本文从源码出发，一步一步解析清楚。

## hmap：map 的顶层结构

在 Go runtime 中，`map` 对应的结构是 `hmap`：

```go
type hmap struct {
    count     int    // 元素个数
    flags     uint8
    B         uint8  // buckets 数组长度的对数，即 len(buckets) == 2^B
    noverflow uint16 // overflow bucket 近似数量
    hash0     uint32 // 哈希种子

    buckets    unsafe.Pointer // 指向 buckets 数组，大小为 2^B
    oldbuckets unsafe.Pointer // 扩容时保存旧 buckets
    nevacuate  uintptr        // 渐进式扩容时的进度
    extra *mapextra
}
```

每个 `bucket`（桶）对应的结构是 `bmap`：

```go
type bmap struct {
    tophash [bucketCnt]uint8 // 存储 key 哈希值的高 8 位
    // 之后紧跟 key 和 value 的内存区域（编译期生成）
}
```

## 哈希定位过程

当你执行 `m[key]` 时，Go 大致做了这几件事：

1. 计算 `key` 的哈希值 `h`
2. 取低 `B` 位确定 bucket 编号
3. 取高 8 位作为 `tophash` 快速比较
4. 遍历 bucket 中最多 8 个槽位，找到匹配的 key

```go
hash := t.hasher(key, uintptr(h.hash0))
m := bucketMask(h.B)          // 2^B - 1
b := (*bmap)(add(h.buckets, (hash&m)*uintptr(t.bucketsize)))
top := tophash(hash)           // hash >> 56
```

> 为什么先比 `tophash` 再比完整的 key？因为 `tophash` 只有 1 字节，8 个槽位的 tophash 可以一次 SIMD 比较，极大减少了 key 的完整比较次数。

## 扩容策略

Go map 有两种扩容：

| 类型 | 触发条件 | 结果 |
|------|----------|------|
| 翻倍扩容 | `count / 2^B > 6.5`（负载因子超限） | `B++`，bucket 数量翻倍 |
| 等量扩容 | overflow bucket 过多 | B 不变，重新整理碎片 |

扩容是**渐进式**的（incremental rehashing）：每次 map 读写操作时最多迁移 2 个旧 bucket，避免一次性迁移导致的延迟抖动。

## 并发安全

`map` 本身不是并发安全的。并发读写会触发 `flags` 中的写标志检查：

```go
if h.flags&hashWriting != 0 {
    fatal("concurrent map writes")
}
```

并发场景下应该使用：
- `sync.Map`（适合读多写少）
- 加 `sync.RWMutex` 的自定义封装
- 分片锁（高并发场景下更高效）

## 小结

- map 底层是 `hmap + bmap` 的链式哈希结构
- `tophash` 是快速比较的关键优化
- 扩容为渐进式，避免 stop-the-world
- 并发读写必须自己加锁或使用 `sync.Map`

下一篇将继续分析 `sync.Map` 的 `dirty` 和 `read` 双结构设计。
