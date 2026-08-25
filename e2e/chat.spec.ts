import { expect, test } from "@playwright/test";

test.describe("Eve chat", () => {
  test("renders ready chat controls without an error", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Eve Agent" })).toBeVisible();
    await expect(page.getByPlaceholder("Type your message...")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
    await expect(page.locator(".status")).toHaveText("Ready");
    await expect(page.locator(".status")).toHaveCSS("background-color", "rgb(17, 170, 85)");
    await expect(page.locator(".error-message")).toHaveCount(0);
  });

  test("uses the browser proxy health endpoint", async ({ page, request }) => {
    await page.goto("/");
    const response = await request.get("/api/eve/v1/health");

    expect(response.status()).toBe(200);
    await expect(page.locator(".status")).toHaveText("Ready");
  });

  test("sends a message through the proxy and receives an answer", async ({
    page,
  }) => {
    const proxyResponses: number[] = [];
    const proxyPaths: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith("/api/eve/")) {
        proxyPaths.push(pathname);
      }
    });
    page.on("response", (response) => {
      if (new URL(response.url()).pathname.startsWith("/api/eve/v1/")) {
        proxyResponses.push(response.status());
      }
    });

    await page.goto("/");
    const input = page.getByPlaceholder("Type your message...");
    const send = page.getByRole("button", { name: "Send" });

    await input.fill("Reply with a short acknowledgement.");
    await send.click();

    await expect(page.locator(".message.user")).toContainText(
      "Reply with a short acknowledgement.",
    );
    await expect(page.locator(".message.assistant p")).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.locator(".status")).toHaveText("Ready");
    await expect(page.locator(".error-message")).toHaveCount(0);
    expect(proxyPaths.every((path) => !path.includes("/api/eve/eve/"))).toBe(
      true,
    );
    expect(proxyResponses).toContain(202);
    expect(proxyResponses).toContain(200);
  });

  test("displays 'Eve' label for assistant messages", async ({ page }) => {
    await page.goto("/");
    const input = page.getByPlaceholder("Type your message...");
    const send = page.getByRole("button", { name: "Send" });

    await input.fill("Reply with a short acknowledgement.");
    await send.click();

    // Wait for the assistant reply to appear
    await expect(page.locator(".message.assistant")).toBeVisible({
      timeout: 45_000,
    });

    // The label should say "Eve", not "assistant"
    const label = page.locator(".message.assistant strong");
    await expect(label).toHaveText("Eve", { timeout: 5_000 });
  });

  test("shows the enlarged avatar image in the chat header", async ({ page }) => {
    await page.goto("/");

    const avatar = page.locator("header img.eve-avatar");
    await expect(avatar).toBeVisible();
    await expect(avatar).toHaveAttribute("alt", "Eve");
    await expect(avatar).toHaveAttribute("width", "150");
    await expect(avatar).toHaveAttribute("height", "150");
    await expect(avatar).toHaveCSS("width", "150px");
    await expect(avatar).toHaveCSS("height", "150px");
  });
});