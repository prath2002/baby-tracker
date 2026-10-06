import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const LOG = process.env.SERVER_LOG!;
const SHOTS = process.env.SHOTS_DIR ?? "e2e-shots";
const email = `e2e+${Date.now()}@example.in`;

async function codeFor(addr: string) {
  for (let i = 0; i < 20; i++) {
    const m = [...readFileSync(LOG, "utf8").matchAll(new RegExp(`to=${addr.replace(/[+.]/g, "\\$&")}[\\s\\S]*?code is (\\d{6})`, "g"))];
    if (m.length) return m[m.length - 1][1];
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("no code");
}
const shot = (p: Page, n: string) => p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });

test("parent journey: onboard → baby → feeds → summary", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await page.waitForURL(/welcome|login/);
  await shot(page, "01-onboarding");
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel("6-digit code").fill(await codeFor(email));
  await shot(page, "02-login-code");
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await page.waitForURL(/register/);
  await page.getByLabel("Your name").fill("Priya");
  await page.getByRole("switch", { name: "I am the parent or lawful guardian" }).click();
  await page.getByRole("switch", { name: "I am 18 or older" }).click();
  const popup = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Read the full privacy notice" }).click();
  await (await popup).close();
  await page.getByRole("switch", { name: /I consent to processing/ }).click();
  await shot(page, "03-register");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(/babies\/new/);

  await page.getByLabel("First name").fill("Aarav");
  await page.getByRole("radio", { name: "Boy" }).click();
  await page.getByLabel("Date of birth").fill("2026-06-27");
  await page.getByLabel("Birth weight").fill("3.1");
  await page.getByLabel("Gestational age (weeks)").fill("39");
  await shot(page, "04-add-baby");
  await page.getByRole("button", { name: "Save baby" }).click();
  await page.waitForURL(/babies\/[0-9a-f-]+\?added=1/);
  await expect(page.getByText("14 weeks").first()).toBeVisible();
  await shot(page, "05-overview");

  // second baby (twin) for wrong-baby safeguards
  await page.goto("/babies/new");
  await page.getByLabel("First name").fill("Anaya");
  await page.getByRole("radio", { name: "Girl" }).click();
  await page.getByLabel("Date of birth").fill("2026-06-27");
  await page.getByRole("button", { name: "Save baby" }).click();
  await page.waitForURL(/babies\/[0-9a-f-]+\?added=1/);

  await page.goto("/home");
  await expect(page.getByRole("heading", { name: "Aarav" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Anaya" })).toBeVisible();
  await shot(page, "06-home-two-babies");

  // Quick log requires explicit baby choice
  await page.getByRole("button", { name: "Log for a baby" }).click();
  await page.getByRole("button", { name: "Add feeding" }).click();
  await expect(page.getByRole("dialog", { name: "Who is this for?" })).toBeVisible();
  await shot(page, "07-baby-picker");
  await page.getByRole("button", { name: /Aarav/ }).click();
  await page.waitForURL(/feedings\/new/);
  await expect(page.getByText("For Aarav", { exact: true })).toBeVisible();
  await page.getByRole("radio", { name: /Breastfeed/ }).click();
  await page.getByRole("radio", { name: "Left" }).click();
  await page.getByLabel(/Duration/).fill("12");
  await shot(page, "08-add-breastfeed");
  await page.getByRole("button", { name: /Save feed for Aarav/ }).click();
  await page.waitForURL(/milk/);

  await page.goto(page.url().replace("/milk", "/feedings/new"));
  await page.getByRole("radio", { name: /Expressed/ }).click();
  await page.getByRole("button", { name: "90 ml" }).click();
  await page.getByRole("button", { name: /Save feed for Aarav/ }).click();
  await page.waitForURL(/milk/);
  await expect(page.getByText("90 ml measurable milk recorded.")).toBeVisible();
  await expect(page.getByText("Additional direct breastfeeding sessions were recorded but not converted to volume.")).toBeVisible();
  await expect(page.getByText("No universal milk amount applies", { exact: true })).toBeVisible();
  await expect(page.getByText(/should drink|required milk/i)).toHaveCount(0);
  await shot(page, "09-milk-dashboard");

  await page.goto(page.url().replace("/milk", "/weight?add=1"));
  await page.getByLabel("Weight", { exact: true }).fill("5.6");
  await page.getByRole("button", { name: /Save for Aarav/ }).click();
  await expect(page.getByText(/5\.6 kg/).first()).toBeVisible();
  await shot(page, "10-weight");

  await page.goto(page.url().replace(/\/weight.*/, "/growth"));
  await expect(page.getByText(/official WHO dataset has not been imported|pending clinical review/)).toBeVisible();
  await shot(page, "11-growth-gated");

  await page.goto(page.url().replace("/growth", "/vaccinations"));
  await expect(page.getByText("Schedule pending clinical verification")).toBeVisible();
  await shot(page, "12-vaccines-gated");

  await page.goto(page.url().replace("/vaccinations", "/allergies"));
  await page.getByRole("button", { name: "+ Add" }).click();
  await page.getByLabel("Substance", { exact: false }).fill("Egg");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Allergies: Egg (suspected)" })).toBeVisible();
  await shot(page, "13-allergies");

  await page.goto(page.url().replace("/allergies", "/summary/weekly"));
  await expect(page.getByText(/Feeds recorded on \d+ of \d+ days/)).toBeVisible();
  await shot(page, "14-weekly-summary");

  await page.goto("/timeline");
  await expect(page.getByText(/Allergy recorded · Egg/)).toBeVisible();
  await shot(page, "15-unified-timeline");

  await page.goto("/settings");
  await shot(page, "16-settings");

  expect(errors.filter((e) => !/Failed to load resource.*(401|409|422)/.test(e))).toEqual([]);
});
