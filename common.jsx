export const STATUS = {
  NEW: { label: "Нове", cls: "new" },
  CONFIRMED: { label: "Підтверджено", cls: "ok" },
  PREPARING: { label: "Готується", cls: "cook" },
  COMPLETED: { label: "Завершено", cls: "done" },
  CANCELLED: { label: "Скасовано", cls: "cancel" },
};

export const money = (n) => `${Number(n || 0).toLocaleString("uk-UA")} ₴`;
export const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD
const CATEGORY_LABELS = {
  starter: "Закуски",
  soup: "Супи",
  main: "Основні страви",
  salad: "Салати",
  dessert: "Десерти",
  drink: "Напої",
};
export const menuCategoryLabel = (category) => CATEGORY_LABELS[category] || category;

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d + n).toLocaleDateString("sv-SE");
}

export function dayLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("uk-UA", {
    weekday: "short",
    day: "numeric",
    month: "long",
  });
}

export function dishesLabel(n) {
  if (!n) return "Без страв";
  const last = n % 10;
  const tail = n % 100;
  if (last === 1 && tail !== 11) return `${n} страва`;
  if (last >= 2 && last <= 4 && (tail < 12 || tail > 14)) return `${n} страви`;
  return `${n} страв`;
}

export function Badge({ status }) {
  const s = STATUS[status] || { label: status, cls: "new" };
  return <span className={`badge ${s.cls}`}>• {s.label}</span>;
}

export function PageHead({ title, subtitle, children }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        <p className="muted">{subtitle}</p>
      </div>
      <div className="head-actions">{children}</div>
    </header>
  );
}
