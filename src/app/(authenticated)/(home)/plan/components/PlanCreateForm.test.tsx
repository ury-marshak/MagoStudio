import { Img2ImgSchema } from "@home/components/Navbar/Img2ImgModalV2/schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { beforeEach, expect, it, vi } from "vitest";

import { rendererLibrary } from "@/platform/rendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { PlanCreateForm } from "./PlanCreateForm";
import type { PlanImg2ImgSectionHandle } from "./PlanImg2ImgSection";

const { createPlan, getValues, showHintToast, showToast, trigger } = vi.hoisted(
  () => ({
    createPlan: vi.fn(),
    getValues: vi.fn(),
    showHintToast: vi.fn(),
    showToast: vi.fn<(toast: { onSubmit: () => Promise<void> }) => void>(),
    trigger: vi.fn<() => Promise<boolean>>()
  })
);

vi.mock("@domains/plan/api/createPlan", () => ({ createPlan }));
vi.mock("@domains/project/useProject", () => ({
  useProject: () => ({ data: [{ id: "shot-1", name: "Shot 1", layers: [] }] })
}));
vi.mock("@domains/plan/usePlanShotImageAssignments", () => ({
  usePlanShotImageAssignments: () => ({ uploads: [], manualOverrides: {} })
}));
vi.mock("@store/useToast", () => ({
  useToast: () => ({ showHintToast, showToast })
}));
vi.mock("./PlanCreateSubmitButton", () => ({
  PlanCreateSubmitButton: () => <button type="submit">Create plan</button>
}));
vi.mock("./PlanNameInput", () => ({ PlanNameInput: () => null }));
vi.mock("./shotPicker/PlanShotPickerField", () => ({
  PlanShotPickerField: () => null
}));
vi.mock("./PlanShotImagesSection", () => ({
  PlanShotImagesSection: () => null
}));
vi.mock("./PlanVideoSection", () => ({ PlanVideoSection: () => null }));
vi.mock("./PlanImg2ImgSection", () => ({
  PlanImg2ImgSection: forwardRef<PlanImg2ImgSectionHandle>(
    function Section(_, ref) {
      useImperativeHandle(ref, () => ({ trigger, getValues }));
      return null;
    }
  )
}));

beforeEach(() => {
  vi.clearAllMocks();
  trigger.mockResolvedValue(true);
  getValues.mockReturnValue(
    Img2ImgSchema.parse({ model: "nanobanana_pro", frameType: "video" })
  );
  createPlan.mockResolvedValue({ id: "plan-1" });
});

const switchLibrary = () =>
  act(async () => {
    await rendererLibrary.suspend();
    rendererLibrary.reset();
  });

const setup = async () => {
  const onCreated = vi.fn();
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <PlanCreateForm
        projectId="project-1"
        initialSettings={{ timeline_ids: ["shot-1"] }}
        onCreated={onCreated}
        onCancel={vi.fn()}
      />
    </QueryClientProvider>
  );
  fireEvent.click(screen.getByRole("button", { name: "Create plan" }));
  await waitFor(() => expect(showToast).toHaveBeenCalledOnce());
  return {
    confirm: showToast.mock.calls[0][0].onSubmit,
    onCreated,
    invalidate
  };
};

it("ignores a confirmation that outlives its library", async () => {
  const { confirm, onCreated } = await setup();
  await switchLibrary();
  await act(confirm);
  expect(trigger).not.toHaveBeenCalled();
  expect(createPlan).not.toHaveBeenCalled();
  expect(onCreated).not.toHaveBeenCalled();
});

it("does not read the form or dispatch after delayed preflight crosses a switch", async () => {
  const preflight = Promise.withResolvers<boolean>();
  trigger.mockReturnValueOnce(preflight.promise);
  const { confirm } = await setup();
  const creation = confirm();
  expect(trigger).toHaveBeenCalledOnce();
  await switchLibrary();
  preflight.resolve(true);
  await act(() => creation);
  expect(getValues).not.toHaveBeenCalled();
  expect(createPlan).not.toHaveBeenCalled();
});

it("ignores a late creation result without invalidating or publishing success", async () => {
  const response = Promise.withResolvers<{ id: string }>();
  createPlan.mockReturnValueOnce(response.promise);
  const { confirm, onCreated, invalidate } = await setup();
  const creation = confirm();
  await waitFor(() => expect(createPlan).toHaveBeenCalledOnce());
  await switchLibrary();
  response.resolve({ id: "plan-1" });
  await act(() => creation);
  expect(invalidate).not.toHaveBeenCalled();
  expect(showHintToast).not.toHaveBeenCalled();
  expect(onCreated).not.toHaveBeenCalled();
});

it("invalidates plans and publishes success while the originating library is active", async () => {
  const { confirm, onCreated, invalidate } = await setup();
  await act(confirm);
  expect(createPlan).toHaveBeenCalledOnce();
  expect(invalidate).toHaveBeenCalledExactlyOnceWith({
    queryKey: queryKeys.plans.all
  });
  expect(showHintToast).toHaveBeenCalledOnce();
  expect(onCreated).toHaveBeenCalledOnce();
});
