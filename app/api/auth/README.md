# app/api/auth

## Overview
Authentication subsystem API blueprint coordinating Google OAuth, developer login, and session clearance.

## Subdirectories & Boundaries
- [dev](./dev/README.md) - Development and E2E mock authentication route
- [google](./google/README.md) - Google OAuth 2.0 flow endpoints
- [signout](./signout/README.md) - Signout endpoint clearing session cookie
