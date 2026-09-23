import { expect, it } from "vitest";
import { belongsToLockedDuty } from "./lockedDuty";
import type { Dienst, Movement } from "./types";

const service: Dienst = { id: "s", sourceFile: "test", pageNumber: 1, serviceNumber: "L7156", sourceFileId: "file", divisionId: "lkn" };
const movement: Movement = { id: "m", sourceFile: "test", pageNumber: 1, sourceFileId: "file", divisionId: "lkn", dienstnummer: "L7156", type: "rit", vertrek: "12:00", aankomst: "13:00", lijnnummer: "400", ritnummer: "1001", omloopnummer: "807156", van: "A", naar: "B", raw: "" };

it("markeert alleen de gekozen bron en divisie", () => {
  expect(belongsToLockedDuty(movement, service)).toBe(true);
  expect(belongsToLockedDuty(movement)).toBe(false);
  expect(belongsToLockedDuty({ ...movement, sourceFileId: "other" }, service)).toBe(false);
  expect(belongsToLockedDuty({ ...movement, divisionId: "other" }, service)).toBe(false);
  expect(belongsToLockedDuty({ ...movement, dienstnummer: "L7157" }, service)).toBe(false);
});

it("vindt alleen de werkelijk opgenomen ritten van een persoonlijke dienst", () => {
  const personal = [{ ...movement, dienstnummer: "P-7156/2", sourceFileId: "personal-1" }];
  expect(belongsToLockedDuty(movement, service, personal)).toBe(true);
  expect(belongsToLockedDuty({ ...movement, ritnummer: "1002" }, service, personal)).toBe(false);
  expect(belongsToLockedDuty({ ...movement, vertrek: "11:00" }, service, personal)).toBe(false);
  expect(belongsToLockedDuty({ ...movement, divisionId: "other" }, service, personal)).toBe(false);
});
