import { afterEach, expect, it, vi } from "vitest";

const track = vi.hoisted(() => vi.fn());
vi.mock("@amplitude/analytics-browser", () => ({ track }));

afterEach(() => {
  Reflect.deleteProperty(window, "mago");
  vi.clearAllMocks();
});

it.each(["offline", "unchosen", undefined, "cloud", "web"])(
  "uses the explicit account choice for direct tracking in %s mode",
  async (choice) => {
    if (choice !== "web")
      Object.defineProperty(window, "mago", {
        configurable: true,
        value: { account: { mode: choice } }
      });
    const { trackingUtils } = await import("./trackingUtils");
    trackingUtils.projectActions.create("local-project", "Private local title");
    trackingUtils.projectActions.rename("local-project", "Before", "After");
    if (choice === "cloud" || choice === "web") {
      expect(track.mock.calls).toEqual([
        [
          "project_create",
          { project_id: "local-project", project_name: "Private local title" }
        ],
        [
          "project_rename",
          {
            project_id: "local-project",
            old_project_name: "Before",
            new_project_name: "After"
          }
        ]
      ]);
    } else expect(track).not.toHaveBeenCalled();
  }
);
