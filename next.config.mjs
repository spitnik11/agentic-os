/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /*
   * The TypeScript sources import with explicit `.js` extensions, which is the
   * convention that keeps the same files loadable by `tsc`, by `tsx` in the
   * standalone scripts, and by Node directly. Webpack needs to be told to map
   * those specifiers back to the `.ts` files on disk.
   */
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },

  turbopack: {
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'],
  },
};

export default nextConfig;
