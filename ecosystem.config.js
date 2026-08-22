// pm2 process definition: keeps Aurora alive across crashes and (via
// pm2-windows-startup + pm2 save) brings it back automatically after login.
module.exports = {
  apps: [
    {
      name: "aurora",
      script: "server.js",
      cwd: __dirname,
      autorestart: true,
      restart_delay: 3000, // breathe between crash-restarts
      max_restarts: 50, // within pm2's default 15s window counter
      // Recycle if something leaks badly. MUST carry a unit: pm2 parses this
      // with the `bytes` library, so a bare "15" means fifteen BYTES and the app
      // would restart-loop the instant it booted. It reads ~160 MB streaming.
      max_memory_restart: "1500M",
      kill_timeout: 8000, // let jsonstore flush on SIGINT before force-kill
      // libuv's threadpool serves ALL file I/O (every streaming read), DNS and
      // async crypto. It defaults to 4 threads regardless of machine size, so
      // on this box a few concurrent streams plus a password hash queued behind
      // each other. 8 leaves ample room for ffmpeg and node.
      // Read once at startup, hence here rather than in code.
      env: { NODE_ENV: "production", UV_THREADPOOL_SIZE: "6" },
    },
  ],
};
