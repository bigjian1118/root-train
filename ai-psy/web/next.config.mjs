/** @type {import('next').NextConfig} */
// 注意：rewrites 的 destination 在 `next build` 时就被写入 routes-manifest，
// 因此构建时必须显式传入 BACKEND_URL（run\启动.bat 与 start_all.sh 均已传入）。
// 默认值必须是后端端口 6007；若写成 6006 会代理到自身，页面所有 /api 请求都会挂起。
const backendUrl = (process.env.BACKEND_URL || 'http://127.0.0.1:6007').replace(/\/+$/, '');

const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // 服务器实例内存有限：构建默认按 CPU 核数开满 worker，
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
