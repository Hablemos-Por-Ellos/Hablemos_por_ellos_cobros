import { Duplex } from "node:stream";
import { execFileSync, spawn } from "node:child_process";

export function assertLocalLab(container) {
  if (!/^hpe-(admin|backup)-lab-[a-z0-9-]+$/.test(container ?? "")) throw new Error("EXPLICIT_LAB_TARGET_REQUIRED");
  const label = execFileSync("docker", ["inspect", "--format", '{{index .Config.Labels "codex.project"}}', container], { encoding: "utf8", windowsHide: true }).trim();
  if (!["hpe-admin-030", "hpe-backup-030"].includes(label)) throw new Error("CONTAINER_NOT_OWNED_BY_THIS_LAB");
}

// pg uses its normal wire protocol over Docker stdin/stdout; no host port or egress is needed.
export function localDockerStream(container) {
  assertLocalLab(container);
  return new class extends Duplex {
    connect() {
      this.child = spawn("docker", ["exec", "-i", container, "nc", "127.0.0.1", "5432"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      this.child.stderr.resume();
      this.child.once("spawn", () => this.emit("connect"));
      this.child.once("error", (error) => this.destroy(error));
      this.child.stdout.on("data", (chunk) => { if (!this.push(chunk)) this.child.stdout.pause(); });
      this.child.stdout.once("end", () => this.push(null));
      this.child.stdin.on("error", (error) => this.destroy(error));
      this.child.once("close", (code) => { if (code && !this.destroyed) this.destroy(new Error("LOCAL_DOCKER_TRANSPORT_FAILED")); });
      return this;
    }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    _read() { this.child?.stdout.resume(); }
    _write(chunk, encoding, callback) { this.child.stdin.write(chunk, encoding, callback); }
    _final(callback) { this.child?.stdin.end(callback); }
    _destroy(error, callback) { this.child?.kill(); callback(error); }
  }();
}
