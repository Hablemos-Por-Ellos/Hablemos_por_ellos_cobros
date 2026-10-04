const maintenanceEnabled = process.env.MAINTENANCE_MODE === "true";
const { execFileSync } = require("node:child_process");
const packageJson = require("./package.json");
let commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "";
if (!commit) {
  try {
    commit = execFileSync("git", ["-c", `safe.directory=${process.cwd().replaceAll("\\", "/")}`, "rev-parse", "--short=7", "HEAD"], {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    }).trim().slice(0, 7);
  } catch { commit = ""; }
}

const nextConfig = {
  distDir: process.env.HPE_LOCAL_INTEGRATION === "true" && !process.env.VERCEL
    ? ".next-integration" : ".next",
  logging: {
    incomingRequests: { ignore: [/\/admin\/auth\/callback(?:\?|$)/] },
  },
  env: {
    NEXT_PUBLIC_BUILD_VERSION: packageJson.version,
    NEXT_PUBLIC_BUILD_DATE: process.env.BUILD_DATE || new Date().toISOString(),
    NEXT_PUBLIC_BUILD_COMMIT: commit,
    NEXT_PUBLIC_BUILD_STATE: process.env.VERCEL_ENV === "production" ? "Build de produccion" : "Local / no confirmado",
  },
  images: {
    unoptimized: true,
  },
  async redirects() {
    if (!maintenanceEnabled) {
      return [];
    }

    return [
      {
        source: "/((?!api|admin|_next|mantenimiento|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)",
        destination: "/mantenimiento",
        permanent: false,
      },
    ];
  },
};

module.exports = nextConfig;
