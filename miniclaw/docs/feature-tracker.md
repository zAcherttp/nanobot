# Miniclaw Feature Tracker

This document provides a high-level, progressively updated architecture map of the Miniclaw daemon and harness. It illustrates the currently implemented features, separation of concerns, and data flow.

## System Architecture

```mermaid
graph TD
    %% =============================================
    %% CLI Layer
    %% =============================================
    subgraph CLI ["🖥️ CLI Interface (Commander)"]
        Index["miniclaw CLI (tsdown)"]
        GlobalErr["Global Error Handler"]
        
        Index --> GatewayCmd["gateway command"]
        Index --> OnboardCmd["onboard command"]
        
        GatewayCmd -.->|"Catches & Handles"| GlobalErr
        OnboardCmd -.->|"Catches & Handles"| GlobalErr
    end

    %% =============================================
    %% Services Layer
    %% =============================================
    subgraph Services ["⚙️ Service Layer (Business Logic)"]
        GatewaySvc["GatewayService"]
        OnboardSvc["OnboardService"]
        ConfigSvc["ConfigService<br/>(Zod + Validation)"]
        FileSystemSvc["FileSystemService<br/>(Cross-Platform)"]
        
        GatewayCmd -->|"Instantiates"| GatewaySvc
        OnboardCmd -->|"Instantiates"| OnboardSvc
        
        GatewaySvc -->|"Uses"| ConfigSvc
        OnboardSvc -->|"Uses"| ConfigSvc
        OnboardSvc -->|"Uses"| FileSystemSvc
        ConfigSvc -->|"Uses"| FileSystemSvc
    end

    %% =============================================
    %% Core Infrastructure
    %% =============================================
    subgraph Core ["🔧 Core Infrastructure"]
        Bus["MessageBus<br/>(EventEmitter)"]
        Logger["Logger (Pino + pino-pretty)"]
        
        GatewaySvc -->|"Initializes"| Bus
        Services -.->|"All services log to"| Logger
    end

    %% =============================================
    %% Gateway & API Layer
    %% =============================================
    subgraph API ["🌐 API Runtime (Hono)"]
        HonoApp["Hono Server"]
        SSE["SSE Broadcaster<br/>(/stream)"]
        Health["Health Check<br/>(/api/health)"]
        
        GatewaySvc -->|"Boots"| HonoApp
        HonoApp --> SSE
        HonoApp --> Health
        
        HonoApp <-->|"Pub/Sub Events"| Bus
    end

    %% =============================================
    %% File System Layer
    %% =============================================
    subgraph FS ["📁 File System (.miniclaw)"]
        MiniclawDir[".miniclaw/ (Root)"]
        ConfigJSON["config.json"]
        ThreadsDir["threads/ (History)"]
        WorkspaceDir["workspace/ (Sandbox)"]
        
        MiniclawDir --- ConfigJSON
        MiniclawDir --- ThreadsDir
        MiniclawDir --- WorkspaceDir
        
        ConfigSvc <-->|"Read/Write"| ConfigJSON
        OnboardSvc -->|"Scaffolds"| ThreadsDir
        OnboardSvc -->|"Scaffolds"| WorkspaceDir
    end

    %% =============== Styling ===================
    classDef cli fill:#1e3a8a, color:#fff, stroke:#60a5fa, stroke-width:3px, font-weight:bold;
    classDef svc fill:#166534, color:#fff, stroke:#4ade80, stroke-width:3px;
    classDef core fill:#4338ca, color:#fff, stroke:#818cf8, stroke-width:3px;
    classDef api fill:#9f1239, color:#fff, stroke:#fb7185, stroke-width:3px;
    classDef fs fill:#44403c, color:#f5f5f4, stroke:#d6d3d1, stroke-width:3px;

    class Index,GatewayCmd,OnboardCmd,GlobalErr cli;
    class GatewaySvc,OnboardSvc,ConfigSvc,FileSystemSvc svc;
    class Bus,Logger core;
    class HonoApp,SSE,Health api;
    class MiniclawDir,ConfigJSON,ThreadsDir,WorkspaceDir fs;
```

## Implemented Feature Checklist

- **CLI Shell**: `commander` router with globally abstracted error handling.
- **Build System**: `tsdown` (Rolldown/Vite) outputting an ultra-fast, extensionless native `.mjs` ESM bundle.
- **Service Isolation**: Clean separation of `OnboardService`, `GatewayService`, and `ConfigService`.
- **Cross-Platform FS**: `FileSystemService` with dynamic environment detection (`import.meta.url`) and native OS support (`os.homedir()`).
- **Intelligent Config**: Automatic relative path resolution bound natively to the dynamic `.`+`appName` working directory, validated via `zod`.
- **Logging**: Asynchronous-blocking `pino-pretty` preventing TTY overlaps with interactive prompts (`inquirer`).
- **Communication Bus**: High-performance, decoupled `MessageBus` (EventEmitter) ready to sync the Gateway API and the background Agent loop.
- **API Server**: Fast `hono/node-server` exposing a REST health check and an SSE (Server-Sent Events) event stream.

## Upcoming Milestones

*(To be mapped into the architecture diagram as they are built)*

- [ ] **Agent Core**: LLM Loop Orchestration and Provider Interface (OpenRouter, local models).
- [ ] **Persistence Layer**: JSON and JSONL based storing for easy access and human-readability on personal computers, persisting the `MessageBus` to `.miniclaw/threads/`.
- [ ] **Tools & Abilities**: FS Sandbox tools interacting with `.miniclaw/workspace/`.
