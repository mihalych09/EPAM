import {
  CognitoUserPool,
  CognitoUser,
  CognitoUserAttribute,
  AuthenticationDetails,
} from 'amazon-cognito-identity-js';

const pool = new CognitoUserPool({
  UserPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
  ClientId: import.meta.env.VITE_COGNITO_CLIENT_ID,
});

const norm = (email) => email.trim().toLowerCase();
const userOf = (email) => new CognitoUser({ Username: norm(email), Pool: pool });
const cb = (res, rej) => (err, data) => (err ? rej(err) : res(data));

// З токена беремо пошту та групи. Роль визначає саме токен, а не вибір на екрані входу.
function toUser(session) {
  const p = session.getIdToken().decodePayload();
  const groups = p['cognito:groups'] || [];
  return { email: p.email, groups, isAdmin: groups.includes('admin') };
}

export const signUp = (email, password) =>
  new Promise((res, rej) =>
    pool.signUp(
      norm(email),
      password,
      [new CognitoUserAttribute({ Name: 'email', Value: norm(email) })],
      null,
      cb(res, rej)
    )
  );

export const confirmSignUp = (email, code) =>
  new Promise((res, rej) => userOf(email).confirmRegistration(code.trim(), true, cb(res, rej)));

export const resendCode = (email) =>
  new Promise((res, rej) => userOf(email).resendConfirmationCode(cb(res, rej)));

export const signIn = (email, password) =>
  new Promise((res, rej) =>
    userOf(email).authenticateUser(
      new AuthenticationDetails({ Username: norm(email), Password: password }),
      {
        onSuccess: (session) => res(toUser(session)),
        onFailure: rej,
        newPasswordRequired: () => rej({ code: 'NewPasswordRequired' }),
      }
    )
  );

export const signOut = () => pool.getCurrentUser()?.signOut();

// Повертає користувача, якщо в браузері є дійсна сесія, інакше null
export const getCurrentUser = () =>
  new Promise((res) => {
    const u = pool.getCurrentUser();
    if (!u) return res(null);
    u.getSession((err, s) => res(err || !s?.isValid() ? null : toUser(s)));
  });

// JWT для заголовка Authorization у запитах до API
export const getIdToken = () =>
  new Promise((res) => {
    const u = pool.getCurrentUser();
    if (!u) return res(null);
    u.getSession((err, s) => res(err || !s?.isValid() ? null : s.getIdToken().getJwtToken()));
  });

const ERRORS = {
  UsernameExistsException: 'Така пошта вже зареєстрована. Перейдіть на вкладку «Вхід».',
  InvalidPasswordException: 'Пароль не відповідає вимогам: мінімум 10 символів, великі й малі літери та цифра.',
  InvalidParameterException: 'Перевірте пошту й пароль.',
  CodeMismatchException: 'Невірний код. Перевірте лист і спробуйте ще раз.',
  ExpiredCodeException: 'Код прострочено. Надішліть новий.',
  NotAuthorizedException: 'Невірна пошта або пароль.',
  UserNotFoundException: 'Невірна пошта або пароль.',
  UserNotConfirmedException: 'Пошту ще не підтверджено.',
  NewPasswordRequired: 'Потрібно встановити постійний пароль. Зверніться до власника системи.',
  LimitExceededException: 'Забагато спроб. Зачекайте кілька хвилин.',
  TooManyRequestsException: 'Забагато запитів. Спробуйте за хвилину.',
  TooManyFailedAttemptsException: 'Забагато невдалих спроб. Спробуйте пізніше.',
};

export const errCode = (e) => e?.code || e?.name;
export const errText = (e) => ERRORS[errCode(e)] || 'Щось пішло не так. Спробуйте ще раз.';
