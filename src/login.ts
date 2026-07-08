import { load } from "cheerio";
import makeFetchCookie from "fetch-cookie";
import { CookieJar } from "tough-cookie";

export type PasswordLoginInput = {
  baseUrl: string;
  email: string;
  password: string;
  loginPath?: string;
};

export type PasswordLoginResult = {
  sesskey: string;
  cookies: string;
  loginUrl: string;
  finalUrl: string;
};

export function extractSesskey(html: string): string | null {
  const patterns = [
    /"sesskey"\s*:\s*"([^"]+)"/,
    /M\.cfg\.sesskey\s*=\s*'([^']+)'/,
    /sesskey=([a-zA-Z0-9]+)/
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function detectLoginForm(html: string): {
  action: string;
  fields: URLSearchParams;
  usernameField: string;
  passwordField: string;
} {
  const $ = load(html);
  const form = $("form").has("input[type='password']").first();

  if (!form.length) {
    throw new Error("No password login form found. The site may require SSO-only login or JavaScript-driven auth.");
  }

  const action = form.attr("action") ?? "";
  const fields = new URLSearchParams();

  form.find("input[type='hidden']").each((_, el) => {
    const name = $(el).attr("name");
    const value = $(el).attr("value") ?? "";
    if (name) {
      fields.set(name, value);
    }
  });

  const passInput = form.find("input[type='password']").first();
  const passwordField = passInput.attr("name");
  if (!passwordField) {
    throw new Error("Could not detect password field name in login form.");
  }

  const usernamePriority = [
    "username",
    "email",
    "user",
    "j_username",
    "UserName",
    "loginfmt"
  ];

  let usernameField: string | undefined;
  for (const candidate of usernamePriority) {
    const found = form.find(`input[name='${candidate}']`).first();
    if (found.length) {
      usernameField = candidate;
      break;
    }
  }

  if (!usernameField) {
    const genericUserInput = form.find("input[type='text'], input[type='email']").first();
    usernameField = genericUserInput.attr("name") ?? undefined;
  }

  if (!usernameField) {
    throw new Error("Could not detect username/email field in login form.");
  }

  return {
    action,
    fields,
    usernameField,
    passwordField
  };
}

export async function loginWithPassword(input: PasswordLoginInput): Promise<PasswordLoginResult> {
  const loginPath = input.loginPath ?? "/login/index.php";
  const loginUrl = new URL(loginPath, input.baseUrl).toString();

  const jar = new CookieJar();
  const cookieFetch = makeFetchCookie(fetch, jar);

  const loginPageRes = await cookieFetch(loginUrl, { redirect: "follow" });
  const loginPageHtml = await loginPageRes.text();

  const formInfo = detectLoginForm(loginPageHtml);
  const submitUrl = new URL(formInfo.action || loginPageRes.url || loginUrl, loginUrl).toString();

  formInfo.fields.set(formInfo.usernameField, input.email);
  formInfo.fields.set(formInfo.passwordField, input.password);

  const submitRes = await cookieFetch(submitUrl, {
    method: "POST",
    redirect: "follow",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: formInfo.fields.toString()
  });

  const submitHtml = await submitRes.text();
  const maybeError = /loginerrors|loginerrormessage|invalid|incorrect/i.test(submitHtml);

  const myRes = await cookieFetch(new URL("/my/", input.baseUrl).toString(), { redirect: "follow" });
  const myHtml = await myRes.text();

  const sesskey = extractSesskey(myHtml) ?? extractSesskey(submitHtml);
  if (!sesskey) {
    throw new Error(
      "Login flow did not expose a Moodle sesskey. This account likely requires federated SSO/MFA not compatible with direct email/password form POST."
    );
  }

  const cookies = await jar.getCookieString(input.baseUrl);
  if (!cookies) {
    throw new Error("Login did not produce cookies for the Moodle host.");
  }

  if (maybeError && !/\/my\//i.test(myRes.url)) {
    throw new Error("Credentials were rejected by login form.");
  }

  return {
    sesskey,
    cookies,
    loginUrl,
    finalUrl: myRes.url
  };
}
