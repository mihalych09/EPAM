export const HALLS = Array.from({ length: 5 }, (_, index) => index + 1);
export const TABLE_CAPACITIES = [2, 3, 4, 5, 5];
export const BOOKING_DURATION_MINUTES = 120;

function getTables(booking) {
  if (Array.isArray(booking.tables) && booking.tables.length) return booking.tables;
  return Number.isInteger(booking.table) ? [booking.table] : [];
}

function minutesOfDay(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function isOccupied(bookings, booking, hall, tables) {
  return bookings.some((other) => {
    if (
      other.id === booking.id ||
      other.date !== booking.date ||
      !["CONFIRMED", "PREPARING"].includes(other.status) ||
      (other.hall ?? 1) !== hall ||
      Math.abs(minutesOfDay(other.time) - minutesOfDay(booking.time)) >= BOOKING_DURATION_MINUTES
    ) {
      return false;
    }

    return getTables(other).some((table) => tables.includes(table));
  });
}

export function availableSeating(bookings, booking) {
  const placements = [];

  HALLS.forEach((hall) => {
    for (let start = 1; start <= TABLE_CAPACITIES.length; start += 1) {
      const tables = [];
      let seats = 0;

      for (let end = start; end <= TABLE_CAPACITIES.length; end += 1) {
        tables.push(end);
        seats += TABLE_CAPACITIES[end - 1];

        const isSingleTable = tables.length === 1;
        if (seats < booking.guests || (booking.guests <= 5 && !isSingleTable)) continue;
        if (booking.guests > 5 && isSingleTable) continue;

        if (!isOccupied(bookings, booking, hall, tables)) {
          placements.push({ hall, tables: [...tables], seats });
        }
        break;
      }
    }
  });

  return placements;
}

export function seatingOptionId(placement) {
  return `${placement.hall}:${placement.tables.join(",")}`;
}

export function seatingLabel(booking) {
  const tables = getTables(booking);
  if (!tables.length) return "Місце не призначено";
  return `Зал ${booking.hall ?? 1} · столик${tables.length === 1 ? "" : "и"} ${tables.join(", ")}`;
}
