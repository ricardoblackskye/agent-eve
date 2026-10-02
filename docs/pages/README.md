# Documentation

How the Agent Eve Dark Factory fits together. Each page links to the code it
describes, and design decisions live as [Architecture Decision Records](../adr/README.md)
— read those for *why* the system is shaped this way.

## Contents

- [System Overview](overview.md)
- [Request and authentication flows](flows.md)
- [Deployment and project structure](deployment.md)
- [Environment Variables](configuration.md)
- [Platform adapters (R6 foundation)](platform-adapters.md)
- [Dark Factory (R1)](dark-factory.md)
- [Dark Factory operations](dark-factory-operations.md)

## Dark Factory flow deep-dives

- [End-to-end run lifecycle](flow-run-lifecycle.md)
- [Control plane and gates](flow-control-plane.md)
- [Worker sandbox and credential boundary](flow-worker-sandbox.md)
- [Cost and usage governance](flow-cost-governance.md)
- [Tenant attribution and reporting](flow-tenant-attribution.md)
- [Observability](flow-observability.md)
