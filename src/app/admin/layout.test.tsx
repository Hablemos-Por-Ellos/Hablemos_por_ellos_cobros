import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
const auth = vi.hoisted(() => ({ client: vi.fn(), service: vi.fn() }));
vi.mock("@/lib/supabase-auth-server", () => ({ getServerAuthSupabaseClient: auth.client }));
vi.mock("@/lib/supabase-server", () => ({ getServiceSupabaseClient: auth.service }));
import AdminLayout, { dynamic } from "./layout";

describe("request-only admin rendering", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });
  it("forces the entire admin page tree to render per request, including demo builds", () => {
    expect(dynamic).toBe("force-dynamic");
  });
  it("does not authenticate or load data while importing/rendering the layout", () => {
    render(<AdminLayout><span>Runtime fixture child</span></AdminLayout>);
    expect(screen.getByText("Runtime fixture child")).toBeInTheDocument();
    expect(auth.client).not.toHaveBeenCalled();
    expect(auth.service).not.toHaveBeenCalled();
  });
});
