const maintenanceEnabled = process.env.MAINTENANCE_MODE === "true";

const nextConfig = {
  images: {
    unoptimized: true,
  },
  async redirects() {
    if (!maintenanceEnabled) {
      return [];
    }

    return [
      {
        source: "/((?!api|_next|mantenimiento|favicon.ico|robots.txt|sitemap.xml).*)",
        destination: "/mantenimiento",
        permanent: false,
      },
    ];
  },
};

module.exports = nextConfig;
