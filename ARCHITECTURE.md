# Architecture

This document describes the architecture of the Agent Eve application.

## System Overview

```mermaid
graph TB
    User["User / Browser"] --> NextJS["Next.js App<br/>(Vercel)"]
    NextJS --> Proxy["API Proxy<br/>app/api/eve/v1/[...slug]"]
    NextJS --> UI["Web UI<br/>app/chat.tsx"]
    Proxy --> EveAgent["Eve Agent<br/>agent/"]
    EveAgent --> OpenRouter["OpenRouter API"]
    OpenRouter --> LLM["NVIDIA Nemotron<br/>3 Ultra 550B"]

    style User fill:#1a3a5c,stroke:#4a8ad4,color:#e5e5e5
    style NextJS fill:#2d2d2d,stroke:#555,color:#e5e5e5
    style Proxy fill:#1a1a2e,stroke:#4a4a8a,color:#e5e5e5
    style EveAgent fill:#1a2e1a,stroke:#4a8a4a,color:#e5e5e5
    style OpenRouter fill:#2e1a1a,stroke:#8a4a4a,color:#e5e5e5
    style LLM fill:#1a1a2e,stroke:#6a4a8a,color:#e5e5e5
```

## Request Flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant N as Next.js Server
    participant P as API Proxy
    participant E as Eve Agent
    participant O as OpenRouter
    participant M as Model

    B->>N: GET / (loads chat UI)
    N-->>B: HTML + JS
    B->>P: POST /api/eve/v1/session
    Note over P: Adds Authorization header<br/>(EVE_API_KEY from env)
    P->>E: POST /eve/v1/session
    E->>O: API call (OpenRouter)
    O->>M: Inference request
    M-->>O: Response tokens
    O-->>E: Streamed response
    E-->>P: NDJSON event stream
    P-->>B: Streamed response
    B->>P: GET /api/eve/v1/session/:id/stream
    P->>E: GET /eve/v1/session/:id/stream
    E-->>P: Events
    P-->>B: Events
```

## Authentication Flow

```mermaid
flowchart LR
    subgraph Production
        VP["Vercel Platform Call"] -->|OIDC| V["vercelOidc()"]
        V -->|Authenticated| C["Channel<br/>eve.ts"]
    end

    subgraph Development
        LD["Local Dev Request"] -->|localhost| L["localDev()"]
        L -->|Authenticated| C
    end

    subgraph External
        API["API Client<br/>(Bearer Token)"] -->|Authorization header| BA["bearerAuth()"]
        BA -->|Valid token| C
        BA -->|Invalid token| R["401 Unauthorized"]
    end

    style VP fill:#1a3a5c,stroke:#4a8ad4
    style LD fill:#2d2d2d,stroke:#555
    style API fill:#2e1a1a,stroke:#8a4a4a
    style C fill:#1a2e1a,stroke:#4a8a4a
    style R fill:#3a1a1a,stroke:#8a3a3a
```

## Deployment Architecture

```mermaid
graph TB
    subgraph Production["Production (Vercel)"]
        PA["agent-eve-gold.vercel.app"]
        PA -->|No auth wall| PP["API Proxy"]
        PA -->|No auth wall| PU["Web UI"]
    end

    subgraph Preview["Preview (Vercel)"]
        PR["agent-*.vercel.app"]
        PR -->|Vercel Auth| PRP["API Proxy"]
        PRP -->|Bypass header| PRE["Eve Agent"]
        PR -->|Vercel Auth| PRU["Web UI"]
    end

    subgraph Local["Local Development"]
        L["http://localhost:3000"]
        L --> LP["API Proxy"]
        L --> LU["Web UI"]
        LP -->|Direct| LE["Eve Agent"]
    end

    style Production fill:#1a2e1a,stroke:#4a8a4a
    style Preview fill:#2e2e1a,stroke:#8a8a4a
    style Local fill:#1a1a2e,stroke:#4a4a8a
```

## Project Structure

```mermaid
graph LR
    subgraph Root["Project Root"]
        A["agent/"]
        APP["app/"]
        E2E["e2e/"]
        EVALS["evals/"]
        PLANS["plans/"]
        PUB["public/"]
    end

    subgraph Agent["agent/"]
        AT["agent.ts<br/>(Model config)"]
        AI["instructions.md"]
        CH["channels/eve.ts<br/>(Auth)"]
    end

    subgraph App["app/"]
        CHAT["chat.tsx<br/>(UI)"]
        CSS["globals.css"]
        LAY["layout.tsx"]
        PROXY["api/eve/v1/[...slug]/route.ts<br/>(Proxy)"]
        ARCH["architecture/page.tsx<br/>(This page)"]
    end

    Root --> Agent
    Root --> App
    Root --> E2E
    Root --> EVALS
    Root --> PLANS
    Root --> PUB
```

## Data Flow: Chat Session

```mermaid
sequenceDiagram
    participant U as User
    participant C as Chat Component
    participant EA as useEveAgent
    participant P as API Proxy
    participant E as Eve Agent

    U->>C: Types message
    U->>C: Clicks Send
    C->>EA: send("message")
    EA->>P: POST /api/eve/v1/session
    P->>E: POST /eve/v1/session<br/>(with API key)
    E-->>P: {"ok":true, "sessionId":"..."}
    P-->>EA: {"ok":true, "sessionId":"..."}
    EA->>P: GET /api/eve/v1/session/:id/stream
    P->>E: GET /eve/v1/session/:id/stream
    Note over E: Agent processes message
    E-->>P: NDJSON events (message.appended, etc.)
    P-->>EA: NDJSON events
    EA->>C: Updates message list
    C-->>U: Displays response
```

## Environment Variables

| Variable                   | Purpose                                 | Required         |
| -------------------------- | --------------------------------------- | ---------------- |
| `OPENROUTER_API_KEY`       | API key for OpenRouter model access     | Yes              |
| `EVE_API_KEY`              | Bearer token for Eve API authentication | Yes              |
| `VERCEL_PROTECTION_BYPASS` | Bypass token for Vercel preview auth    | For preview only |
