import "@testing-library/jest-dom";
import { vi } from "vitest";

// Fixtures use local URLs; imported Next helpers cannot inherit production hosts.
vi.stubEnv("APP_OPERATION_MODE", "active");
vi.stubEnv("FINANCIAL_OPERATIONS_ENABLED", "true");
vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "local-test-service-key");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "local-test-anon-key");
vi.stubEnv("NEXT_PUBLIC_WOMPI_ENV", "sandbox");
