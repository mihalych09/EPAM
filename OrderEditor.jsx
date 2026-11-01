import { useEffect, useState } from "react";
import { api } from "./api";
import { money } from "./common";

// Full order editing is limited to NEW; confirmed orders only allow adding dishes.
export default function OrderEditor({ summary, onChanged, allowParticipantRemoval = true }) {
  const bookingId = summary.booking.id;
  const editable = summary.booking.status === "NEW";
  const canAddDishes = editable || summary.booking.status === "CONFIRMED";
  const [dishes, setDishes] = useState([]);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!canAddDishes) return;
    api("/menu")
      .then((d) => setDishes(d.dishes || []))
      .catch((e) => setError(e.message));
  }, [canAddDishes]);

  async function run(fn) {
    try {
      setError("");
      await fn();
      await onChanged();
    } catch (e) {
      setError(e.message);
    }
  }

  const save = (participant, items) =>
    run(() =>
      api(`/bookings/${bookingId}/orders`, {
        method: "POST",
        body: {
          participant,
          items: items.map(({ dish_id, qty }) => ({ dish_id, qty })),
        },
      })
    );

  const removeParticipant = (participant) => {
    if (!window.confirm(`Видалити учасника «${participant}» із замовлення?`)) return;
    run(() => api(`/bookings/${bookingId}/orders/remove`, { method: "POST", body: { participant } }));
  };

  const changeQty = (p, dishId, delta) => {
    const items = p.items
      .map((i) => (i.dish_id === dishId ? { ...i, qty: Math.min(i.qty + delta, 20) } : i))
      .filter((i) => i.qty > 0);
    save(p.participant, items);
  };

  const addDish = (p, dishId) => {
    if (!dishId) return;
    const exists = p.items.some((i) => i.dish_id === dishId);
    const items = exists
      ? p.items.map((i) => (i.dish_id === dishId ? { ...i, qty: Math.min(i.qty + 1, 20) } : i))
      : [...p.items, { dish_id: dishId, qty: 1 }];
    save(p.participant, items);
  };

  function addParticipant(e) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    save(name, []).then(() => setNewName(""));
  }

  return (
    <>
      {summary.participants.length === 0 && <div className="muted small">Страв ще не обрано.</div>}

      {summary.participants.map((p) => (
        <div key={p.participant} className="participant">
          <div className="p-head">
            <strong>{p.participant}</strong>
            <span className="row-gap">
              {money(p.subtotal)}
              {editable && allowParticipantRemoval && (
                <button
                  className="icon-btn"
                  title="Видалити учасника"
                  onClick={() => removeParticipant(p.participant)}
                >
                  🗑
                </button>
              )}
            </span>
          </div>

          {p.items.map((it) => (
            <div key={it.dish_id} className="line">
              <div>
                {it.name}
                <div className="muted small">
                  {it.qty} × {money(it.price)}
                </div>
              </div>
              <span className="row-gap">
                {editable && (
                  <span className="qty">
                    <button className="qty-btn" onClick={() => changeQty(p, it.dish_id, -1)}>
                      −
                    </button>
                    <span>{it.qty}</span>
                    <button className="qty-btn" onClick={() => changeQty(p, it.dish_id, 1)}>
                      +
                    </button>
                  </span>
                )}
                {money(it.line_total)}
              </span>
            </div>
          ))}

          {canAddDishes && (
            <select className="add-dish" value="" onChange={(e) => addDish(p, e.target.value)}>
              <option value="" disabled>
                ＋ Додати страву
              </option>
              {dishes.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {money(d.price)}
                </option>
              ))}
            </select>
          )}
        </div>
      ))}

      {editable && (
        <form className="add-participant" onSubmit={addParticipant}>
          <input
            placeholder="Ім'я учасника"
            value={newName}
            maxLength={50}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button className="btn">＋ Учасник</button>
        </form>
      )}

      {error && <div className="error small">{error}</div>}
    </>
  );
}
