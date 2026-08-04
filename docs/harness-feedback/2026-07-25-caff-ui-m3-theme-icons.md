---
feature_ids: [CAFF-UI-M3]
topics: [harness-feedback, frontend, ui, visual-quality, vision-translation]
doc_kind: harness-feedback
feedback_type: feature-fit-review
feature_id: CAFF-UI-M3
thread_ids: []
session_ids: []
cats: [cat-ir4rwo6b, opus, cat-mcmk1s9b]
primary_failure_class: taste_gap
status: resolved
created: 2026-07-25
---

# Harness Feedback — CAFF UI M3 Theme and Line Icons

## Trigger

M1/M2 后 operator 明确表示新版“比原来的好很多”，但仍有三项可感知差距：

> “AI 味道还是有点重。”
>
> “UI 我想改支持 dark 和 light 两种风格。”
>
> “图标不要 emoji 风格，要线条矢量图的风格（类似 Clowder 的）。”

Canonical source message: `0001784943824058-001634-16bccd22`。

## Feature Fit Review

```yaml
feature_fit_review:
  trigger: "operator 对上一阶段视觉结果明确不满意，且提出 Light/Dark 与 Clowder 式线性图标"
  cvo_signal: "功能结构更好，但合成式渐变、玻璃感、胶囊和 emoji chrome 仍显得有 AI 模板味"
  cat_translation: >
    把主观 taste signal 转成 active chrome 的可测约束：flat semantic surfaces、无装饰性
    gradient/backdrop blur、6/8/10/12px geometry、repository-owned currentColor SVG、
    双主题真实浏览器 Journey 与独立 vision guardian。
  harness_path_taken:
    - "design brief §11：原话到终态约束的一一映射"
    - "feature spec：ThemePreference 状态机、INV-1..7、视觉 anti-pattern census"
    - "TDD：theme/icon contracts + hidden participant Red→Green probe"
    - "browser verifier：五 route × 两主题 + 1440/820/375 + contrast/radius/containment"
    - "cross-individual code review + third-cat visual guardian"
    - "R1 continuity review：43.5px verifier 容差收紧为精确 44px"
  evidence_refs:
    - "message:0001784943824058-001634-16bccd22"
    - "feature-specs/2026-07-25-caff-ui-theme-icons.md"
    - "review-notes/2026-07-25-caff-ui-theme-icons-review-request.md"
    - "docs/bug-report/caff-theme-participant-card/bug-report.md"
    - "docs/bug-report/caff-theme-toggle-verifier-threshold/bug-report.md"
    - "message:0001784954231371-001784-392e4b17"
    - "message:0001784956043604-001804-18463a62"
    - "message:0001784956529839-001825-fac1b550"
  primary_failure_class: taste_gap
  secondary_failure_class: translation_gap
  corrective_action:
    - "把审美反馈固定成 project-local design truth 与可执行测试，而非继续凭形容词迭代"
    - "让真实隐藏 surface 进入 dogfood/browser probe，避免首屏全绿掩盖 Dark 亮斑"
    - "让视觉守护猫逐字对照 operator experience，并以截图与 computed style 放行"
  owner: "砚砚（实现/收尾）+ 宪宪（code review）+ 烁烁（vision guardian）"
```

## Classification

| Failure class | 判定 | 理由 |
|---|---|---|
| `taste_gap` | primary | 上一阶段功能与布局契约成立，但视觉语言仍不符合 operator 对“克制、像 Clowder”的审美标准。 |
| `translation_gap` | secondary | “AI 味”起初没有被拆成 gradient、blur、shadow、radius、pill 与 emoji chrome 等可观测信号。 |
| `harness_misfit` | not primary | 既有 review flow 能承载修正；M3 补齐 project-local contracts 和视觉守护后即得到稳定结果，无需新增全局工具。 |
| `execution_gap` | no | M1/M2 完成的是其冻结 scope；M3 中发现的 participant 与 43.5px 问题都遵循 Red→Green 在 close 前解决。 |
| `environment_drift` | no | 独立 sandbox、Edge、临时 SQLite 与 local-main acceptance 结果一致。 |

## Harness Fit Outcome

- 有效路径是“原话 → 项目级 design truth → hard browser gate → 独立 vision guardian”，而不是继续增加抽象视觉形容词。
- computed-style probe 必须覆盖隐藏 drawer/card 等非首屏 chrome；本次 participant bug 证明只拍五 route 首屏不足以判断 Dark 完整性。
- 精确 AC 不应由 verifier 自行放宽。`a26a2a7` 已把 44px 合同、测试和真实浏览器值重新对齐。
- 本反馈为 annotations + evidence refs；未复制 raw tool-call payload。M3 已通过 code review、vision review 和 93/93 acceptance，状态记为 `resolved`。
