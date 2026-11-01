import { useState } from "react";
import { confirmSignUp, isAdmin, login, logout, resendCode, signUp } from "../api";

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim());
const passwordOk = (p) => p.length >= 10 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p);

const roleGrid = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 16 };
const roleBtn = { padding: "22px 8px", fontSize: "1rem" };
const rowBetween = { display: "flex", justifyContent: "space-between", marginTop: 14 };
const codeInput = { letterSpacing: "0.5em", textAlign: "center", fontSize: "1.4rem" };

/* Екран входу: вибір «Гість» / «Адмін». Роль визначається групою в токені, а не вибором. */
export default function Login({ onLogin }) {
  const [view, setView] = useState("role"); // role | admin | guest | verify
  const [tab, setTab] = useState("reg"); // reg | in
  const [f, setF] = useState({ email: "", password: "", password2: "", code: "" });
  const [msg, setMsg] = useState(null); // { text, ok }
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const go = (v) => {
    setView(v);
    setMsg(null);
  };

  function submit(action) {
    return async (e) => {
      e.preventDefault();
      setBusy(true);
      setMsg(null);
      try {
        await action();
      } catch (err) {
        setMsg({ text: err.message, ok: false });
      } finally {
        setBusy(false);
      }
    };
  }

  const register = async () => {
    if (!emailOk(f.email)) throw new Error("Введіть коректну пошту.");
    if (!passwordOk(f.password)) throw new Error("Пароль: мінімум 10 символів, великі й малі літери та цифра.");
    if (f.password !== f.password2) throw new Error("Паролі не збігаються.");
    await signUp(f.email, f.password);
    setF({ ...f, code: "" });
    setView("verify");
    setMsg({ text: "Код надіслано на вашу пошту.", ok: true });
  };

  const verify = async () => {
    if (f.code.trim().length < 6) throw new Error("Введіть 6-значний код з листа.");
    await confirmSignUp(f.email, f.code);
    onLogin(await login(f.email, f.password)); // пошту підтверджено, одразу входимо
  };

  const resend = async () => {
    setBusy(true);
    try {
      await resendCode(f.email);
      setMsg({ text: "Новий код надіслано.", ok: true });
    } catch (err) {
      setMsg({ text: err.message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  const guestLogin = async () => {
    try {
      onLogin(await login(f.email, f.password));
    } catch (err) {
      if (err.code !== "UserNotConfirmedException") throw err;
      await resendCode(f.email);
      setView("verify");
      setMsg({ text: "Підтвердіть пошту: ми надіслали новий код.", ok: true });
    }
  };

  const adminLogin = async () => {
    const token = await login(f.email, f.password);
    if (!isAdmin(token)) {
      logout();
      throw new Error("Цей обліковий запис не має прав адміністратора.");
    }
    onLogin(token);
  };

  const Message = () =>
    msg && <div className={msg.ok ? "muted small" : "error"}>{msg.text}</div>;

  return (
    <div className="center-screen">
      <div className="card login">
        <div className="logo">VERDE</div>
        <div className="muted small">РЕСТОРАН · КИЇВ</div>

        {view === "role" && (
          <>
            <h2>Ласкаво просимо</h2>
            <p className="muted">Оберіть, як ви хочете увійти</p>
            <div style={roleGrid}>
              <button className="btn" style={roleBtn} onClick={() => go("guest")}>
                👤 Гість
              </button>
              <button className="btn" style={roleBtn} onClick={() => go("admin")}>
                🛡️ Адмін
              </button>
            </div>
          </>
        )}

        {view === "admin" && (
          <form onSubmit={submit(adminLogin)}>
            <h2>Вхід для адміністратора</h2>
            <label>Email</label>
            <input type="email" autoComplete="username" value={f.email} onChange={set("email")} required />
            <label>Пароль</label>
            <input type="password" autoComplete="current-password" value={f.password} onChange={set("password")} required />
            <Message />
            <button className="btn primary" disabled={busy}>
              {busy ? "Входимо…" : "Увійти"}
            </button>
            <div style={rowBetween}>
              <button type="button" className="btn" onClick={() => go("role")}>
                Назад
              </button>
            </div>
          </form>
        )}

        {view === "guest" && (
          <form onSubmit={submit(tab === "reg" ? register : guestLogin)}>
            <h2>Гість</h2>
            <div className="tabs">
              <button type="button" className={tab === "reg" ? "tab active" : "tab"} onClick={() => { setTab("reg"); setMsg(null); }}>
                Реєстрація
              </button>
              <button type="button" className={tab === "in" ? "tab active" : "tab"} onClick={() => { setTab("in"); setMsg(null); }}>
                Вхід
              </button>
            </div>
            <label>Email</label>
            <input type="email" autoComplete="username" value={f.email} onChange={set("email")} required />
            <label>Пароль</label>
            <input
              type="password"
              autoComplete={tab === "reg" ? "new-password" : "current-password"}
              value={f.password}
              onChange={set("password")}
              required
            />
            {tab === "reg" && (
              <>
                <label>Повторіть пароль</label>
                <input type="password" autoComplete="new-password" value={f.password2} onChange={set("password2")} required />
              </>
            )}
            <Message />
            <button className="btn primary" disabled={busy}>
              {tab === "reg" ? "Отримати код на пошту" : busy ? "Входимо…" : "Увійти"}
            </button>
            <div style={rowBetween}>
              <button type="button" className="btn" onClick={() => go("role")}>
                Назад
              </button>
            </div>
          </form>
        )}

        {view === "verify" && (
          <form onSubmit={submit(verify)}>
            <h2>Підтвердіть пошту</h2>
            <p className="muted">
              Ми надіслали 6-значний код на {f.email.trim().toLowerCase()}. Перевірте також «Спам».
            </p>
            <input
              style={codeInput}
              inputMode="numeric"
              maxLength={6}
              placeholder="······"
              autoComplete="one-time-code"
              value={f.code}
              onChange={set("code")}
              required
            />
            <Message />
            <button className="btn primary" disabled={busy}>
              {busy ? "Перевіряємо…" : "Підтвердити"}
            </button>
            <div style={rowBetween}>
              <button type="button" className="btn" disabled={busy} onClick={resend}>
                Надіслати код ще раз
              </button>
              <button type="button" className="btn" onClick={() => { setTab("reg"); go("guest"); }}>
                Змінити пошту
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
