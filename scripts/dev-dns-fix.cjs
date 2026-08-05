// Local-development-only DNS preload for `worker:video:dev`. On this Windows
// machine, Hyper-V/WSL2's Internet Connection Sharing (ICS) service causes
// Node's dns.getServers() to report 127.0.0.1 (which refuses connections)
// instead of the machine's actual, correctly configured adapter DNS servers.
// Restarting the ICS service does not clear this (its own stop consistently
// fails while network adapters depend on it). This file is never required by
// the compiled production worker (worker:video / dist/video-worker.js) or by
// any src/ module — it only points Node's resolver at the same public DNS
// servers already configured on the network adapter, so the Atlas SRV
// lookup (_mongodb._tcp...) can succeed.
require("node:dns").setServers(["8.8.8.8", "1.1.1.1"]);
