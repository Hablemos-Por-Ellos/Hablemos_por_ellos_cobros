import { Duplex } from "node:stream";
import { execFileSync, spawn } from "node:child_process";

export function assertLocalLab(container) {
  if (container === "hpe-retry-v040-local") {
    const info = JSON.parse(execFileSync("docker", ["inspect", "--format",
      '{"image":{{json .Config.Image}},"network":{{json .HostConfig.NetworkMode}},"ports":{{json .NetworkSettings.Ports}}}', container],
    { encoding: "utf8", windowsHide: true }));
    if (info.image !== "postgres:16" || info.network !== "none"
      || Object.values(info.ports ?? {}).some(Boolean)) throw new Error("RETRY_LAB_MUST_BE_ISOLATED");
    return;
  }
  if (!/^hpe-(admin|backup)-lab-[a-z0-9-]+$/.test(container ?? "")) throw new Error("EXPLICIT_LAB_TARGET_REQUIRED");
  const label = execFileSync("docker", ["inspect", "--format", '{{index .Config.Labels "codex.project"}}', container], { encoding: "utf8", windowsHide: true }).trim();
  if (!["hpe-admin-030", "hpe-backup-030"].includes(label)) throw new Error("CONTAINER_NOT_OWNED_BY_THIS_LAB");
}

// pg uses its normal wire protocol over Docker stdin/stdout; no host port or egress is needed.
export function localDockerStream(container) {
  assertLocalLab(container);
  return new class extends Duplex {
    connect() {
      // The Debian fixture has Perl but no nc. A single-process relay avoids PID/signal races.
      const relay = container === "hpe-retry-v040-local"
        ? ["perl", "-MIO::Socket::INET", "-MIO::Select", "-e",
          'my $s=IO::Socket::INET->new(PeerAddr=>"127.0.0.1",PeerPort=>5432,Proto=>"tcp") or die "LOCAL_RELAY_FAILED"; '
          + 'my $sel=IO::Select->new(\\*STDIN,$s); while(my @ready=$sel->can_read){for my $h(@ready){'
          + 'my $n=sysread($h,my $b,65536);exit unless defined($n)&&$n;my $dst=fileno($h)==0?$s:\\*STDOUT;'
          + 'while(length($b)){my $w=syswrite($dst,$b);exit unless defined($w)&&$w;substr($b,0,$w,"");}}}']
        : ["nc", "127.0.0.1", "5432"];
      this.child = spawn("docker", ["exec", "-i", container, ...relay], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
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
