/** @type {import('next').NextConfig} */
const backendUrl = (process.env.BACKEND_URL || 'http://127.0.0.1:6006').replace(/\/+$/, '');

const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // AutoDL 实例内存有限：构建默认按 CPU 核数开满 worker，
    // "Collecting page data" 阶段内存峰值过高会被 OOM Killer 杀掉（进程 Killed），
    // 限制为单 worker 构建，牺牲一点速度换取构建稳定。
    cpus: 1,
  },
  async rewrites() {
    // 开发期由 Next 服务端代理到 Flask，浏览器侧保持同源，session cookie 可直接复用
    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
