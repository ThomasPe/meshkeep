# Documentation

| Folder | Content |
|---|---|
| `spec/` | Product specification, technology-neutral. Start with `01-vision.md`. |
| `backlog.md` | Phased product backlog derived from the spec. |
| `open-questions.md` | Unresolved points, referenced from the spec as **[Q#]**. |
| `decisions/` | Architecture decision records: tech stack, UI framework, AI assistance, MCP server. |
| `store/` | Microsoft Store release pipeline and listing texts. |

## Spec

1. [Vision & scope](spec/01-vision.md)
2. [Domain model & data format](spec/02-domain-model.md)
3. [Functional requirements](spec/03-features.md)
4. [Non-functional requirements & quality](spec/04-quality.md)

## Decisions

- [ADR-0001 Application shell / tech stack](decisions/0001-tech-stack.md)
- [ADR-0002 UI framework and visual direction](decisions/0002-ui-framework.md)
- [ADR-0003 AI assistance with a user-supplied API key](decisions/0003-ai-integration.md)
- [ADR-0004 MCP server for AI agents](decisions/0004-mcp-server.md)
