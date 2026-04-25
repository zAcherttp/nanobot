# Miniclaw Feature Tracker

This document provides a high-level, progressively updated architecture map of the Miniclaw daemon and harness. It illustrates the currently implemented features, separation of concerns, and data flow.

## System Architecture

```mermaid
graph TD
    %% CLI Layer
    subgraph CLI ["CLI Interface (Commander)"]
        Index["miniclaw binary (tsdown)"]
        GlobalErr["Global Error Handler"]
        
        Index --> GatewayCmd["'gateway' command"]
        Index --> OnboardCmd["'onboard' command"]
        
        GatewayCmd -.->|"Catches Throws"| GlobalErr
        OnboardCmd -.->|"Catches Throws"| GlobalErr
    end

    %% Services Layer
    subgraph Services ["Service Layer (Pure Business Logic)"]
        GatewaySvc["GatewayService"]
        OnboardSvc["OnboardService"]
        ConfigSvc["ConfigService (Zod Validated)"]
        
        GatewayCmd -->|"Instantiates"| GatewaySvc
        OnboardCmd -->|"Instantiates"| OnboardSvc
        
        GatewaySvc -->|"Loads"| ConfigSvc
        OnboardSvc -->|"Inits/Validates"| ConfigSvc
    end

    %% Core Infrastructure
    subgraph Core ["Core Infrastructure"]
        Bus["MessageBus (EventEmitter)"]
        Logger["Logger (Pino Synchronous stream)"]
        
        GatewaySvc -->|"Creates"| Bus
        Services -.->|"Logs"| Logger
    end

    %% Gateway & API Layer
    subgraph API ["API Runtime (Hono Node Server)"]
        HonoApp["Hono Gateway Server"]
        SSE["SSE Broadcaster (/stream)"]
        Health["Health Check (/api/health)"]
        
        GatewaySvc -->|"Boots"| HonoApp
        HonoApp --> SSE
        HonoApp --> Health
        
        HonoApp <-->|"Pub/Sub"| Bus
    end

    %% File System Layer
    subgraph FS ["File System Isolation"]
        MiniclawDir["./.miniclaw/"]
        ConfigJSON["config.json (Overrides & Defaults)"]
        ThreadsDir["/threads/ (Agent History)"]
        WorkspaceDir["/workspace/ (Tooling Sandbox)"]
        
        MiniclawDir --- ConfigJSON
        MiniclawDir --- ThreadsDir
        MiniclawDir --- WorkspaceDir
        
        ConfigSvc <-->|"Reads/Writes"| ConfigJSON
        OnboardSvc -->|"Scaffolds"| ThreadsDir
        OnboardSvc -->|"Scaffolds"| WorkspaceDir
    end

    classDef cli fill:#f9f,stroke:#333,stroke-width:2px;
    classDef svc fill:#bbf,stroke:#333,stroke-width:2px;
    classDef core fill:#bfb,stroke:#333,stroke-width:2px;
    classDef api fill:#fbf,stroke:#333,stroke-width:2px;
    classDef fs fill:#ddd,stroke:#333,stroke-width:2px;

    class Index,GatewayCmd,OnboardCmd,GlobalErr cli;
    class GatewaySvc,OnboardSvc,ConfigSvc svc;
    class Bus,Logger core;
    class HonoApp,SSE,Health api;
    class MiniclawDir,ConfigJSON,ThreadsDir,WorkspaceDir fs;
```

## Implemented Feature Checklist

- **CLI Shell**: `commander` router with globally abstracted error handling.
- **Build System**: `tsdown` (Rolldown/Vite) outputting an ultra-fast, extensionless native `.mjs` ESM bundle.
- **Service Isolation**: Clean separation of `OnboardService`, `GatewayService`, and `ConfigService`.
- **Intelligent Config**: Automatic relative path resolution bound natively to the `.miniclaw/` working directory, validated via `zod`.
- **Logging**: Asynchronous-blocking `pino-pretty` preventing TTY overlaps with interactive prompts (`inquirer`).
- **Communication Bus**: High-performance, decoupled `MessageBus` (EventEmitter) ready to sync the Gateway API and the background Agent loop.
- **API Server**: Fast `hono/node-server` exposing a REST health check and an SSE (Server-Sent Events) event stream.

## Upcoming Milestones
*(To be mapped into the architecture diagram as they are built)*
- [ ] **Agent Core**: LLM Loop Orchestration and Provider Interface (OpenRouter, local models).
- [ ] **Persistence Layer**: SQLite schema + Drizzle ORM to persist the `MessageBus` to `.miniclaw/threads/`.
- [ ] **Tools & Abilities**: FS Sandbox tools interacting with `.miniclaw/workspace/`.
