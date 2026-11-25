# Permanent Project Rules — Delshiv AI

## Production-Level Coding Standard (Mandatory)
Whenever writing, editing, or refactoring code in this project, always deliver **production-level** code:
1. **Correctness & Reliability**: Handle edge cases, null/undefined values, async/await errors, network/WebSocket disconnects, and invalid inputs gracefully. Never swallow critical errors silently.
2. **No Mockups or Half-Wired Code**: Every UI element, button, filter, tab, and API/WebSocket handler must be fully wired end-to-end with real data and verified behavior.
3. **Clean Architecture**: Keep functions modular, single-purpose, and free of duplicated logic. Use safe HTML escaping (`escapeHtml`) for all dynamic UI rendering to prevent XSS.
4. **Observability & Diagnostics**: Ensure errors, failed steps, root causes, and execution states are clearly surfaced in logs and diagnostic UI so failures are immediately traceable.
5. **Verification**: After making changes, verify syntax, test the running application or endpoints, and confirm there are no console/runtime errors before finishing.
