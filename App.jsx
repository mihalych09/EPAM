import { useCallback, useEffect, useMemo, useState } from "react";
import { api, getToken, isAdmin, logout, parseToken } from "./api";
import { Badge, STATUS, dishesLabel, money, today } from "./common";
import { availableSeating, HALLS, seatingLabel, seatingOptionId } from "./seating";
import OrderEditor from "./OrderEditor";
import BookingsWeek from "./pages/BookingsWeek";
import FloorPlan from "./pages/FloorPlan";
import GuestsPage from "./pages/GuestsPage";
import GuestMenuPage from "./pages/GuestMenuPage";
import MenuPage from "./pages/MenuPage";
import Login from "./pages/Login";

// Має збігатися з TRANSITIONS у bookings.py
const NEXT = {
  NEW: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PREPARING", "CANCELLED"],
  PREPARING: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
};

const NAV = [
  ["orders", "Замовлення гостей"],
  ["week", "Бронювання"],
  ["floor", "План залу"],
  ["menu", "Меню"],
  ["guests", "Гості"],
];

const TABS = [
  { id: "all", label: "Усі замовлення", test: () => true },
  { id: "wait", label: "Очікують", test: (b) => b.status === "NEW" },
  { id: "active", label: "Активні", test: (b) => ["CONFIRMED", "PREPARING"].includes(b.status) },
  { id: "archive", label: "Архів", test: (b) => ["COMPLETED", "CANCELLED"].includes(b.status) },
];

/* ---------- Гостьова частина ---------- */
function GuestHome({ token, onLogout }) {
  const user = parseToken(token);
  return (
    <GuestMenuPage email={user.email} onLogout={onLogout} />
  );
}

/* ---------- Нове бронювання ---------- */
function NewBooking({ defaultDate, onClose, onCreated }) {
  const [f, setF] = useState({
    organizer: "",
    phone: "",
    date: defaultDate,
    time: "19:00",
    guests: 2,
    prepaid: 0,
    notes: "",
  });
  const [error, setError] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    try {
      await api("/bookings", {
        method: "POST",
        body: {
          ...f,
          guests: Number(f.guests),
          prepaid: Number(f.prepaid),
        },
      });
      onCreated();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <form className="card modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Нове замовлення</h2>
        <div className="grid2">
          <div>
            <label>Ім'я гостя</label>
            <input value={f.organizer} onChange={set("organizer")} required maxLength={50} />
          </div>
          <div>
            <label>Телефон</label>
            <input value={f.phone} onChange={set("phone")} maxLength={30} />
          </div>
          <div>
            <label>Дата</label>
            <input type="date" value={f.date} onChange={set("date")} required />
          </div>
          <div>
            <label>Час</label>
            <input type="time" value={f.time} onChange={set("time")} required />
          </div>
          <div>
            <label>Гостей</label>
            <input type="number" min="1" max="30" value={f.guests} onChange={set("guests")} required />
          </div>
          <div>
            <label>Передоплата, ₴</label>
            <input type="number" min="0" value={f.prepaid} onChange={set("prepaid")} />
          </div>
        </div>
        <p className="muted small">Зал і столик буде призначено під час підтвердження бронювання.</p>
        <label>Побажання гостя</label>
        <textarea rows="2" maxLength={300} value={f.notes} onChange={set("notes")} />
        {error && <div className="error">{error}</div>}
        <div className="row-end">
          <button type="button" className="btn" onClick={onClose}>
            Скасувати
          </button>
          <button className="btn primary">Створити</button>
        </div>
      </form>
    </div>
  );
}

function ConfirmSeating({ booking, bookings, busy, error, onClose, onConfirm }) {
  const placements = useMemo(() => availableSeating(bookings, booking), [bookings, booking]);
  const [hall, setHall] = useState(1);
  const hallPlacements = placements.filter((placement) => placement.hall === hall);
  const [selection, setSelection] = useState("");

  useEffect(() => {
    setSelection(hallPlacements[0] ? seatingOptionId(hallPlacements[0]) : "");
  }, [hall, bookings, booking.id, booking.time, booking.guests]);

  const selectedPlacement = hallPlacements.find((placement) => seatingOptionId(placement) === selection);
  const noHallSeats = hallPlacements.length === 0;

  return (
    <div className="overlay" onClick={onClose}>
      <form
        className="card modal"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (selectedPlacement) onConfirm(booking.id, selectedPlacement.hall, selectedPlacement.tables);
        }}
      >
        <h2>Забронювати</h2>
        <p className="muted">
          {booking.organizer} · {booking.date} о {booking.time} · {booking.guests} гостей
        </p>
        <label>Оберіть зал</label>
        <select value={hall} onChange={(event) => setHall(Number(event.target.value))}>
          {HALLS.map((number) => (
            <option key={number} value={number}>
              Зал {number}
            </option>
          ))}
        </select>

        {placements.length === 0 ? (
          <div className="warn">
            Немає вільних місць у жодному залі для цієї кількості гостей на вказаний час.
          </div>
        ) : noHallSeats ? (
          <div className="warn">
            У цьому залі немає вільного місця на потрібну кількість гостей у межах двох годин. Оберіть інший зал.
          </div>
        ) : (
          <>
            <label>Вільне місце</label>
            <select value={selection} onChange={(event) => setSelection(event.target.value)} required>
              {hallPlacements.map((placement) => (
                <option key={seatingOptionId(placement)} value={seatingOptionId(placement)}>
                  Столик{placement.tables.length === 1 ? "" : "и"} {placement.tables.join(", ")} · до {placement.seats} гостей
                </option>
              ))}
            </select>
          </>
        )}

        {error && <div className="error">{error}</div>}
        <div className="row-end">
          <button type="button" className="btn" onClick={onClose}>
            Скасувати
          </button>
          <button className="btn primary" disabled={busy || !selectedPlacement}>
            {busy ? "Підтверджуємо…" : "Підтвердити"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ---------- Права панель ---------- */
function Details({ summary, onClose, onStatus, onChanged }) {
  if (!summary) return <aside className="detail muted">Завантаження…</aside>;
  const b = summary.booking;
  const options = NEXT[b.status] || [];

  return (
    <aside className="detail">
      <div className="detail-head">
        <span className="eyebrow">ЗАМОВЛЕННЯ #{b.id}</span>
        <button className="icon-btn" onClick={onClose} aria-label="Закрити">
          ✕
        </button>
      </div>
      <div className="detail-name">
        <h2>{b.organizer}</h2>
        <Badge status={b.status} />
      </div>
      {b.phone && <div className="muted small">☎ {b.phone}</div>}

      <select
        className="status-select"
        value=""
        disabled={options.length === 0}
        onChange={(e) => e.target.value && onStatus(b.id, e.target.value)}
      >
        <option value="" disabled>
          {options.length ? "Змінити статус замовлення" : "Статус не можна змінити"}
        </option>
        {options.map((s) => (
          <option key={s} value={s}>
            {STATUS[s].label}
          </option>
        ))}
      </select>

      <div className="grid2 info">
        <div>
          <div className="muted small">Дата та час</div>
          <div>
            {b.date} · {b.time}
          </div>
        </div>
        <div>
          <div className="muted small">Місце та гості</div>
          <div>{seatingLabel(b)} · {b.guests} гостей</div>
        </div>
      </div>

      <div className="section-title">
        <span>Передзамовлення</span>
        <span className="muted small">{dishesLabel(summary.total_items)}</span>
      </div>

      <OrderEditor summary={summary} onChanged={onChanged} />

      {summary.warnings.map((w) => (
        <div key={w} className="warn">
          ⚠ {w}
        </div>
      ))}

      <div className="totals">
        <div className="total-main">
          <span>Разом</span>
          <strong>{money(summary.total_amount)}</strong>
        </div>
        <div className="line small muted">
          <span>Передоплата</span>
          <span>{money(summary.prepaid)}</span>
        </div>
        <div className="line small">
          <span>До сплати в ресторані</span>
          <span>{money(summary.amount_due)}</span>
        </div>
      </div>

      {b.notes && (
        <div className="notes">
          <div className="eyebrow">ПОБАЖАННЯ ГОСТЯ</div>
          {b.notes}
        </div>
      )}
    </aside>
  );
}

/* ---------- Адмін-панель ---------- */
function Admin({ token, onLogout }) {
  const user = parseToken(token);
  const [date, setDate] = useState(today());
  const [data, setData] = useState({ stats: { bookings: 0, guests: 0, needs_attention: 0 }, bookings: [] });
  const [newBookings, setNewBookings] = useState([]);
  const [dismissedNotifications, setDismissedNotifications] = useState(() => new Set());
  const [tab, setTab] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [summary, setSummary] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState("");
  const [page, setPage] = useState("orders");

  // Відкрити бронювання (або день) на сторінці замовлень
  function openBooking(day, id) {
    setDate(day);
    setPage("orders");
    setTab("all");
    setQuery("");
    setSelected(id);
  }
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setData(await api(`/bookings?date=${date}`));
    } catch (e) {
      setError(e.message);
    }
  }, [date]);

  const loadNewBookings = useCallback(async () => {
    try {
      const result = await api("/admin/new-bookings");
      setNewBookings(result.bookings);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    if (page !== "orders") return undefined;
    const refresh = window.setInterval(load, 15000);
    return () => window.clearInterval(refresh);
  }, [load, page]);

  useEffect(() => {
    loadNewBookings();
    const refresh = window.setInterval(loadNewBookings, 15000);
    return () => window.clearInterval(refresh);
  }, [loadNewBookings]);

  useEffect(() => {
    if (!selected) {
      setSummary(null);
      return;
    }
    api(`/bookings/${selected}/summary`)
      .then(setSummary)
      .catch((e) => setError(e.message));
  }, [selected, data]);

  async function changeStatus(id, status) {
    if (status === "CONFIRMED") {
      setConfirmError("");
      setConfirming(id);
      return;
    }
    try {
      await api(`/bookings/${id}/status`, { method: "PATCH", body: { status } });
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function confirmBooking(id, hall, tables) {
    setConfirmBusy(true);
    setConfirmError("");
    try {
      await api(`/bookings/${id}/status`, {
        method: "PATCH",
        body: { status: "CONFIRMED", hall, tables },
      });
      setConfirming(null);
      await load();
    } catch (e) {
      setConfirmError(e.message);
      await load();
    } finally {
      setConfirmBusy(false);
    }
  }

  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.id, data.bookings.filter(t.test).length])), [data]);

  const rows = useMemo(() => {
    const current = TABS.find((t) => t.id === tab);
    const q = query.trim().toLowerCase();
    return data.bookings
      .filter(current.test)
      .filter((b) => !q || [b.organizer, b.phone, b.id].some((v) => String(v).toLowerCase().includes(q)));
  }, [data, tab, query]);

  const withDishes = data.bookings.filter((b) => b.total_items > 0).length;
  const activeNotifications = newBookings.filter((booking) => !dismissedNotifications.has(booking.id));
  const tablesCount = new Set(
    data.bookings.flatMap((booking) => {
      const tables = booking.tables?.length ? booking.tables : booking.table ? [booking.table] : [];
      return tables.map((table) => `${booking.hall ?? 1}:${table}`);
    })
  ).size;

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="logo">VERDE</div>
        <div className="muted small">РЕСТОРАН · КИЇВ</div>
        <div className="eyebrow nav-title">КЕРУВАННЯ</div>
        {NAV.map(([id, text]) => (
          <button key={id} className={page === id ? "nav active" : "nav"} onClick={() => setPage(id)}>
            {text}
            {id === "orders" && activeNotifications.length > 0 && (
              <span className="nav-count">{activeNotifications.length}</span>
            )}
          </button>
        ))}
        <div className="spacer" />
        <div className="user">
          <div className="avatar">{(user.name || user.email || "?").slice(0, 2).toUpperCase()}</div>
          <div>
            <div>{user.name || user.email}</div>
            <div className="muted small">Адміністратор</div>
          </div>
          <button className="icon-btn" onClick={onLogout} title="Вийти">
            ⎋
          </button>
        </div>
      </nav>

      <main className="main">
        {activeNotifications.length > 0 && (
          <section className="booking-alerts" aria-live="polite">
            <div className="booking-alerts-heading">
              <strong>Нові запити на бронювання ({activeNotifications.length})</strong>
              <span className="muted small">Оновлюється автоматично</span>
            </div>
            {activeNotifications.map((booking) => (
              <div className="booking-alert" key={booking.id}>
                <span>
                  <strong>{booking.organizer}</strong>
                  <span className="muted"> · {booking.date} о {booking.time} · {booking.guests} гостей</span>
                </span>
                <span className="row-gap">
                  <button className="btn primary" onClick={() => openBooking(booking.date, booking.id)}>
                    Відкрити
                  </button>
                  <button
                    className="icon-btn"
                    aria-label="Закрити сповіщення"
                    onClick={() =>
                      setDismissedNotifications((current) => new Set([...current, booking.id]))
                    }
                  >
                    ✕
                  </button>
                </span>
              </div>
            ))}
          </section>
        )}
        {page === "orders" && (
        <>
        <header className="page-head">
          <div>
            <h1>Замовлення гостей</h1>
            <p className="muted">Кожна деталь — для бездоганного прийому.</p>
          </div>
          <div className="head-actions">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <button className="btn primary" onClick={() => setShowNew(true)}>
              + Нове замовлення
            </button>
          </div>
        </header>

        <section className="stats">
          <div className="stat">
            <div className="muted small">Замовлень сьогодні</div>
            <div className="stat-value">
              {data.stats.bookings} <span className="muted small">на {data.stats.guests} гостей</span>
            </div>
          </div>
          <div className="stat">
            <div className="muted small">Передзамовлення</div>
            <div className="stat-value">
              {withDishes} <span className="muted small">зі стравами</span>
            </div>
          </div>
          <div className="stat">
            <div className="muted small">Заброньовано столиків</div>
            <div className="stat-value">{tablesCount}</div>
          </div>
          <div className="stat">
            <div className="muted small">Потребують уваги</div>
            <div className="stat-value accent">
              {data.stats.needs_attention} <span className="muted small">очікують підтвердження</span>
            </div>
          </div>
        </section>

        {error && <div className="error banner">{error}</div>}

        <div className={`content ${selected ? "with-detail" : ""}`}>
          <section>
            <div className="tabs">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  className={tab === t.id ? "tab active" : "tab"}
                  onClick={() => {
                    setTab(t.id);
                    setSelected(null);
                  }}
                >
                  {t.label} <span className="muted small">{counts[t.id]}</span>
                </button>
              ))}
            </div>
            <input
              className="search"
              placeholder="Ім'я, телефон або номер замовлення"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />

            <div className="table">
              <div className="tr th">
                <span>Гість</span>
                <span>Бронювання</span>
                <span>Страви</span>
                <span>Статус</span>
                <span>Сума</span>
              </div>
              {rows.length === 0 && <div className="empty muted">Немає замовлень на цю дату</div>}
              {rows.map((b) => (
                <div
                  key={b.id}
                  className={`tr ${selected === b.id ? "selected" : ""}`}
                  onClick={() => setSelected(b.id)}
                >
                  <span data-label="Гість">
                    <strong>{b.organizer}</strong>
                    <div className="muted small">
                      #{b.id} {b.phone && `· ${b.phone}`}
                    </div>
                  </span>
                  <span data-label="Бронювання">
                    {b.time} · {b.guests} гості
                    <div className="muted small">{seatingLabel(b)}</div>
                  </span>
                  <span data-label="Страви">{dishesLabel(b.total_items)}</span>
                  <span data-label="Статус">
                    <Badge status={b.status} />
                  </span>
                  <span data-label="Сума">
                    {b.total_items ? money(b.total_amount) : "—"}
                    <div className="muted small">{b.prepaid ? `Внесено ${money(b.prepaid)}` : "Без передоплати"}</div>
                  </span>
                </div>
              ))}
            </div>
          </section>

          {selected && (
            <Details
              summary={summary}
              onClose={() => setSelected(null)}
              onStatus={changeStatus}
              onChanged={load}
            />
          )}
        </div>
        </>
        )}

        {page === "week" && <BookingsWeek date={date} onDate={setDate} onOpen={openBooking} />}
        {page === "floor" && (
          <FloorPlan date={date} onDate={setDate} bookings={data.bookings} onOpen={(id) => openBooking(date, id)} />
        )}
        {page === "menu" && <MenuPage />}
        {page === "guests" && <GuestsPage />}
      </main>

      {showNew && (
        <NewBooking
          defaultDate={date}
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            load();
          }}
        />
      )}
      {confirming && data.bookings.find((booking) => booking.id === confirming) && (
        <ConfirmSeating
          booking={data.bookings.find((booking) => booking.id === confirming)}
          bookings={data.bookings}
          busy={confirmBusy}
          error={confirmError}
          onClose={() => {
            setConfirming(null);
            setConfirmError("");
          }}
          onConfirm={confirmBooking}
        />
      )}
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(getToken());
  const out = () => {
    logout();
    setToken(null);
  };

  if (!token) return <Login onLogin={setToken} />;
  if (!isAdmin(token)) return <GuestHome token={token} onLogout={out} />;
  return <Admin token={token} onLogout={out} />;
}
