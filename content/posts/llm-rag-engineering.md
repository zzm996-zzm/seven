---
title: "RAG 工程实践：从 Naive RAG 到 Advanced RAG 的演进路径"
date: 2026-02-20T10:00:00+08:00
description: "不只是调接口，这篇文章讲透 RAG 在生产环境里真正要解决的工程问题"
categories: ["Tutorial"]
tags: ["LLM", "RAG", "AI 工程", "向量数据库"]
series: ["LLM 工程实践"]
draft: false
---

做过一段时间 LLM 应用开发之后，我发现大部分教程只教你怎么把 LangChain 跑起来，但真正部署到生产时遇到的问题和这些教程差了十万八千里。这篇文章总结我踩过的坑和积累的经验。

## Naive RAG 够用吗？

标准的 RAG 流程很简单：

```
用户问题 → 向量检索 → 拼 Prompt → LLM 生成 → 返回答案
```

这条路走得通，但在生产环境里有几个问题会立刻暴露：

1. **检索召回率低**：用户问的和文档里写的表达方式不一样
2. **上下文窗口浪费**：塞了很多不相关的片段
3. **答案幻觉**：模型倾向于用自己的知识"填空"而不是说不知道
4. **多文档推理失败**：需要跨多段落联合推理时效果很差

## 进阶方案：Query 改写

最便宜、效果最显著的优化之一是**在检索前改写用户 query**：

```python
REWRITE_PROMPT = """
你是一个检索优化助手。请将用户的问题改写为更适合向量检索的形式。
要求：
1. 展开缩写和代词
2. 补全上下文（如果是追问）
3. 拆分成多个子问题（如果问题复杂）

用户问题：{question}
改写后的检索 query（每行一个）：
"""

def rewrite_query(question: str, history: list[dict]) -> list[str]:
    context = format_history(history)
    response = llm.invoke(REWRITE_PROMPT.format(
        question=question,
        history=context
    ))
    return [q.strip() for q in response.split('\n') if q.strip()]
```

改写后用多个 query 分别检索，再做去重和 RRF 融合排序，召回率一般能提升 20-40%。

## Reranker：检索后的二次过滤

向量检索召回的结果按语义相似度排序，但语义相似 ≠ 对回答有用。引入 Cross-Encoder Reranker 做精排：

```python
from sentence_transformers import CrossEncoder

reranker = CrossEncoder('BAAI/bge-reranker-v2-m3')

def rerank(query: str, docs: list[str], top_k: int = 5) -> list[str]:
    pairs = [(query, doc) for doc in docs]
    scores = reranker.predict(pairs)
    ranked = sorted(zip(scores, docs), reverse=True)
    return [doc for _, doc in ranked[:top_k]]
```

> 实测在技术文档问答场景，加了 Reranker 之后答案准确率从 62% 提升到 81%。

## 结构化分块：比 chunk_size 更重要的事

大部分人调半天 `chunk_size` 和 `chunk_overlap`，但真正的问题是分块策略：

- **按语义分块**：用小模型（如 `sentence-transformers`）检测语义断点，比按字数分块效果好得多
- **保留结构**：Markdown 里的标题层级、代码块、表格，不要破坏它
- **父子分块**：检索用小块（精准），喂给模型用父级大块（上下文完整）

## 何时说"不知道"

幻觉问题本质是模型不会说"我不知道"。解法：

1. 在 Prompt 里明确要求：`如果上下文不足以回答，必须明确说明`
2. 检索时加相似度阈值，低于阈值不召回（不能强行检索）
3. 对答案做 self-check：用另一个 prompt 让模型判断自己的答案是否有文档依据

## 小结

RAG 工程的核心不是哪个框架，而是：

- 召回阶段：多路检索 + Query 改写 + Reranker
- 生成阶段：精准分块 + 幻觉控制 + 结构化输出
- 评估阶段：RAGAS 等框架持续监控，不能只靠人工 review

下一篇聊 Agent + RAG 的结合以及 Function Calling 的最佳实践。
