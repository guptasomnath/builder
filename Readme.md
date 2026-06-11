# Builder — Local Docker Build & Deploy Tool

A lightweight CLI tool that builds Docker images **locally** and deploys them to your VPS via SSH/SCP, then runs `docker compose up -d` remotely. No build step happens on the server.

---

## Why Use This?

Many low-cost VPS servers have limited CPU and RAM. Running `docker compose up --build` directly on the server can spike resource usage and cause downtime or timeouts.

**Builder solves this by:**
- Building all Docker images on your local machine (where resources are plentiful)
- Transferring the built images and required files to your VPS over SCP
- Running `docker compose up -d` on the server — which only loads pre-built images, not builds them

This makes deployments safe and fast even on small VPS configurations — ideal for small teams and indie projects.

---

## How It Works

1. Reads your `builder.conf.json` configuration file
2. Builds Docker images locally based on your `docker-compose.yml`
3. Transfers built images + any extra files (env files, nginx config, etc.) to the VPS via SCP
4. SSHs into the VPS and runs `docker compose up -d`
5. Runs any additional commands you specify (e.g., reloading nginx)

---

## Setup

### Prerequisites

- Docker installed locally
- SSH access to your VPS
- `docker compose` available on the VPS

### Configuration

Create a `builder.conf.json` file in the **root directory** (the parent of the `builder` tool folder) before using this tool.

```json
{
  "endCommends": ["docker exec nginx nginx -s reload"],
  "dockerComposePath": "docker-compose.yml",
  "keepFiles": ["client/.env", "nginx", "server/.env", "docker-compose.yml", ".env"],
  "serverInfo": {
    "username": "root",
    "ip": "160.250.205.125",
    "workingDir": "/root/your-project"
  },
  "sshKeyPath": "your_ssh_key_name"
}
```

### Configuration Fields

| Field | Required | Description |
|---|---|---|
| `endCommends` | No | Commands to run on the VPS **after** deploy completes (e.g., reload nginx) |
| `dockerComposePath` | Yes | Path to your `docker-compose.yml`, relative to the root directory |
| `keepFiles` | No | Extra files/folders to upload to the VPS (env files, nginx config, etc.) |
| `serverInfo.username` | Yes | SSH username on the VPS |
| `serverInfo.ip` | Yes | IP address of the VPS |
| `serverInfo.workingDir` | Yes | Absolute working directory path on the VPS |
| `sshKeyPath` | No | Name of your SSH private key file (skips password prompts during deploy) |

### Path Rules

> **Important:** All paths in the config must be written as `folder/file.txt` — **not** `./folder/file.txt` or `/folder/file.txt`.

---

## Usage

Run the tool from the root directory (where `builder.conf.json` lives):

```bash
node builder/index.js
```

Or however the entry point is invoked in your setup.

---

## Project Structure Expectation

```
your-project/               <-- root directory
├── builder.conf.json       <-- required config file (you create this)
├── docker-compose.yml
├── builder/                <-- this tool
│   └── index.js
├── client/
│   └── .env
├── server/
│   └── .env
└── nginx/
```

---

## Contributing

Contributions are welcome! If you find a bug, have a feature request, or want to improve the tool, feel free to open an issue or submit a pull request.

Before contributing:
- Keep changes focused and minimal
- Test your changes against a real VPS deployment if possible
- Follow the existing code style

A note to contributors: this tool was built to solve a real problem for small teams running tight VPS budgets. If you're improving it, keep that user in mind — simplicity and reliability matter more than features.

---

## License

MIT
