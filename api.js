const API = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
const REGION = import.meta.env.VITE_COGNITO_REGION;
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID;
const TOKEN_KEY = "idToken";

export function getToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function logout() {
  sessionStorage.removeItem(TOKEN_KEY);
}

export function parseToken(token) {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(payload)
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("")
    );
    return JSON.parse(json);
  } catch {
    return {};
  }
}

export function isAdmin(token) {
  const groups = parseToken(token)["cognito:groups"] || [];
  return Array.isArray(groups) ? groups.includes("admin") : String(groups).includes("admin");
}

/* ---------- Cognito: прямі запити (без додаткових бібліотек) ---------- */

const ERRORS = {
  UsernameExistsException: "Ця пошта вже зареєстрована. Перейдіть на вкладку «Вхід».",
  InvalidPasswordException: "Пароль не відповідає вимогам: мінімум 10 символів, великі й малі літери та цифра.",
  InvalidParameterException: "Перевірте пошту й пароль.",
  CodeMismatchException: "Невірний код. Перевірте лист і спробуйте ще раз.",
  ExpiredCodeException: "Код прострочено. Надішліть новий.",
  NotAuthorizedException: "Невірна пошта або пароль.",
  UserNotFoundException: "Невірна пошта або пароль.",
  UserNotConfirmedException: "Пошту ще не підтверджено.",
  LimitExceededException: "Забагато спроб. Зачекайте кілька хвилин.",
  TooManyRequestsException: "Забагато запитів. Спробуйте за хвилину.",
  TooManyFailedAttemptsException: "Забагато невдалих спроб. Спробуйте пізніше.",
};

async function cognito(target, params) {
  const res = await fetch(`https://cognito-idp.${REGION}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify({ ClientId: CLIENT_ID, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = String(data.__type || "").split("#").pop();
    const err = new Error(ERRORS[code] || "Щось пішло не так. Спробуйте ще раз.");
    err.code = code;
    throw err;
  }
  return data;
}

const norm = (email) => email.trim().toLowerCase();

// Реєстрація гостя: Cognito сам надішле код на пошту
export function signUp(email, password) {
  return cognito("SignUp", {
    Username: norm(email),
    Password: password,
    UserAttributes: [{ Name: "email", Value: norm(email) }],
  });
}

export function confirmSignUp(email, code) {
  return cognito("ConfirmSignUp", { Username: norm(email), ConfirmationCode: code.trim() });
}

export function resendCode(email) {
  return cognito("ResendConfirmationCode", { Username: norm(email) });
}

// Вхід (USER_PASSWORD_AUTH). Для продакшену краще перейти на SRP.
export async function login(email, password) {
  const data = await cognito("InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    AuthParameters: { USERNAME: norm(email), PASSWORD: password },
  });
  if (!data.AuthenticationResult) throw new Error("Для цього акаунта потрібні додаткові кроки входу");
  const token = data.AuthenticationResult.IdToken; // саме ID-токен, не access
  sessionStorage.setItem(TOKEN_KEY, token);
  return token;
}

/* ---------- Запити до вашого API ---------- */

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    logout();
    window.location.reload();
    throw new Error("Сесія закінчилась, увійдіть знову");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Помилка ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}
