---
description: Debug Docker containers — inspect state, logs, networking, and build issues
---

# docker-debug

Use when the user has a container that won't start, exits unexpectedly, or has networking/volume issues.

## Container won't start

```bash
docker ps -a                          # see exit code
docker logs <container>               # last stdout/stderr
docker inspect <container> | jq '.[0].State'
```

## Build failing

```bash
docker build --no-cache --progress=plain .   # verbose, skip cache
docker build --target <stage> .              # build up to a specific stage
```

## Networking issues

```bash
docker network ls
docker network inspect <network>
docker exec <container> curl http://other-container:3000/health
# check /etc/hosts and resolv.conf inside container:
docker exec <container> cat /etc/hosts
```

## Volume / permission issues

```bash
docker exec <container> ls -la /app
docker exec -u root <container> chown -R node:node /app
```

## Interactive shell in running container

```bash
docker exec -it <container> /bin/sh
# or if bash available:
docker exec -it <container> bash
```

## Common exit codes

| Code | Meaning |
|---|---|
| 1 | General application error |
| 125 | Docker daemon error |
| 126 | Container command not executable |
| 127 | Container command not found |
| 137 | OOM kill (SIGKILL) |
| 143 | SIGTERM (graceful stop timeout) |
