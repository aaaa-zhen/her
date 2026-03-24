const crypto = require("crypto");

const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "";
const validTokens = new Set();

function generateToken() {
  const token = crypto.randomBytes(32).toString("hex");
  validTokens.add(token);
  return token;
}

function parseCookies(cookieStr) {
  const cookies = {};
  cookieStr.split(";").forEach(pair => {
    const [key, val] = pair.trim().split("=");
    if (key && val) cookies[key] = val;
  });
  return cookies;
}

function isAuthenticated(req) {
  if (!AUTH_PASSWORD) return true;
  const cookies = parseCookies(req.headers.cookie || "");
  return validTokens.has(cookies.auth_token);
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>Her — 登录</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, sans-serif;
    background: #0D0D0D; color: #ECECEC;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
  }
  .login-card {
    width: 100%; max-width: 380px; padding: 48px 32px; text-align: center;
  }
  .logo {
    width: 64px; height: 64px; border-radius: 50%;
    background: #6ee7b7;
    display: flex; align-items: center; justify-content: center;
    margin: 0 auto 24px;
  }
  .logo svg { width: 32px; height: 32px; color: #0a0a0a; }
  h1 { font-size: 24px; font-weight: 800; color: #fff; margin-bottom: 8px; }
  p { font-size: 14px; color: #666; margin-bottom: 32px; }
  .input-group { position: relative; margin-bottom: 16px; }
  input[type="password"] {
    width: 100%; padding: 14px 18px; border-radius: 14px;
    background: #181818; border: 1px solid rgba(255,255,255,.07);
    color: #fff; font-size: 15px; font-family: 'Inter', sans-serif;
    outline: none; transition: border-color .2s, box-shadow .2s;
  }
  input[type="password"]:focus {
    border-color: rgba(110,231,183,.4);
  }
  input[type="password"]::placeholder { color: #555; }
  button {
    width: 100%; padding: 14px; border-radius: 14px; border: none;
    background: #6ee7b7;
    color: #0a0a0a; font-size: 15px; font-weight: 700;
    cursor: pointer; transition: opacity .2s, transform .15s;
    font-family: 'Inter', sans-serif;
  }
  button:hover { opacity: .9; }
  button:active { transform: scale(.97); }
  .error {
    color: #F87171; font-size: 13px; margin-top: 12px;
    display: none;
  }
  .error.show { display: block; }
</style>
</head>
<body>
<div class="login-card">
  <div class="logo">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/>
      <path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>
    </svg>
  </div>
  <h1>Her</h1>
  <p>请输入密码以继续</p>
  <form id="loginForm">
    <div class="input-group">
      <input type="password" id="pwd" placeholder="输入密码" autocomplete="current-password" autofocus>
    </div>
    <button type="submit">登录</button>
    <div class="error" id="err">密码错误，请重试</div>
  </form>
</div>
<script>
document.getElementById("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const pwd = document.getElementById("pwd").value;
  if (!pwd) return;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pwd })
    });
    if (res.ok) {
      window.location.href = "/";
    } else {
      document.getElementById("err").classList.add("show");
      document.getElementById("pwd").value = "";
      document.getElementById("pwd").focus();
    }
  } catch (err) {
    document.getElementById("err").textContent = "网络错误";
    document.getElementById("err").classList.add("show");
  }
});
</script>
</body>
</html>`;

function setupAuthRoutes(app) {
  app.get("/login", (req, res) => {
    if (!AUTH_PASSWORD || isAuthenticated(req)) return res.redirect("/");
    res.type("html").send(LOGIN_HTML);
  });

  app.post("/api/login", (req, res) => {
    if (!AUTH_PASSWORD) return res.json({ ok: true });
    const { password } = req.body || {};
    if (password === AUTH_PASSWORD) {
      const token = generateToken();
      res.cookie("auth_token", token, { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 60 * 60 * 1000 });
      res.json({ ok: true });
    } else {
      res.status(401).json({ error: "Invalid password" });
    }
  });

  app.use((req, res, next) => {
    if (!AUTH_PASSWORD) return next();
    if (req.path === "/login" || req.path === "/api/login") return next();
    if (req.path === "/favicon.ico") return next();
    if (req.path.startsWith("/downloads/")) return next();
    if (req.path === "/guide.html") return next();
    if (!isAuthenticated(req)) return res.redirect("/login");
    next();
  });
}

module.exports = { AUTH_PASSWORD, isAuthenticated, setupAuthRoutes };
