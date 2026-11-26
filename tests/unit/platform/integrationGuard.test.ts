import { describe, expect, it } from "vitest";
import { assertLocalTestDatabase } from "../../integration/setup";

describe("integration test database guard", () => {
  it("accepts local *_test databases", () => {
    expect(() => assertLocalTestDatabase("postgresql://itsm:itsm@localhost:5432/itsm_test")).not.toThrow();
    expect(() => assertLocalTestDatabase("postgresql://u:p@127.0.0.1:5432/x_test")).not.toThrow();
    expect(() => assertLocalTestDatabase("postgresql://u:p@postgres:5432/ci_test")).not.toThrow();
  });
  it("refuses remote hosts, including Neon", () => {
    expect(() => assertLocalTestDatabase("postgresql://u:p@ep-cool-123.ap-southeast-1.aws.neon.tech/neondb_test?sslmode=require")).toThrow(/host/);
  });
  it("refuses databases whose name does not end in _test", () => {
    expect(() => assertLocalTestDatabase("postgresql://itsm:itsm@localhost:5432/itsm_dev")).toThrow(/_test/);
  });
  it("refuses garbage", () => {
    expect(() => assertLocalTestDatabase("not a url")).toThrow();
  });
});
