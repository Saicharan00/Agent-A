Extra CA certificates (`*.crt`) trusted inside agenta-bot. `pnpm image:build` copies the Docker Sandbox
proxy CA here before building; the `.crt` files are git-ignored and machine-specific.
