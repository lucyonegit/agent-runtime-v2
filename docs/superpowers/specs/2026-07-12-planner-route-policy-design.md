# Planner 路由策略修复设计

## 问题

当前 Prompt 将“单一最终交付物”视为 direct，即使任务实际需要研究、核验、综合和写作。`qwen-plus` 因此把“调查萧山机场 UFO 事件前因后果，写一个1000字分析报告”明确返回为 `{"strategy":"direct"}`。此外，任何非严格 JSON 输出都会静默回退 direct，使路由长期向 direct 偏斜。

## 路由边界

`direct` 只用于能在一次模型推理中完成、最多需要一次工具调用、无需中间结果验证的普通对话、简单问答或单次操作。

`planned` 用于至少两个相互依赖的执行阶段，包括：

- 调查/研究后形成报告、文章、分析或总结。
- 搜索、核验、综合、生成交付物的链式任务。
- 明确包含“先/然后/之后”等阶段顺序的任务。
- 构建非平凡应用、网站、系统或代码项目。

判断依据是执行阶段，不是最终交付物数量。

## 实现

1. 重写 Router System Prompt，明确上述边界并包含研究报告和复杂构建示例。
2. 保留模型判断，但增加最小确定性保护：研究信号与交付物信号同时出现、明确多阶段、复杂构建任一成立时，最终策略不得降为 direct。
3. 严格解析 `strategy`。允许 JSON 周围存在普通 Markdown code fence，但缺少合法的 direct/planned 值时抛出错误，不再静默回退 direct。
4. 不修改 Job schema、PlanEngine、Store 或事务。

## 测试

- 模型错误返回 direct 时，萧山机场调查报告仍判 planned。
- 普通问候和简单时间查询仍可 direct。
- 明确复杂应用构建判 planned。
- fenced JSON 可以解析。
- 无效输出明确失败，不降级 direct。
- 完整单元测试、PostgreSQL 测试、typecheck 和 build 通过。
