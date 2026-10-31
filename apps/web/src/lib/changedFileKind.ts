const MOCK_NAME =
  /(\.snap$|\.(mocks?|fixtures?|stubs?|fakes?)\.[^.]+$|^(mocks?|fixtures?|stubs?|fakes?)([-_.A-Z]|$))/;
const MOCK_DIRS: Readonly<Record<string, true>> = {
  __fixtures__: true,
  __mocks__: true,
  __snapshots__: true,
  fakes: true,
  fixture: true,
  fixtures: true,
  mock: true,
  mocks: true,
  stubs: true,
  testdata: true,
};

const TEST_NAME =
  /(\.(test|spec|e2e)\.[^.]+$|_(test|spec)\.[^.]+$|^test_.+\.py$|^conftest\.py$|^(vitest|jest)\.setup\.[^.]+$)/i;
const CLASS_TEST_NAME = /(Tests?|Spec)\.(java|kt|kts|scala|groovy|cs|php|swift|m)$/;
const TEST_DIRS: Readonly<Record<string, true>> = {
  __tests__: true,
  __test__: true,
  cypress: true,
  e2e: true,
  spec: true,
  specs: true,
  test: true,
  tests: true,
};

export function isTestChangedFile(path: string): boolean {
  const segments = path.replaceAll("\\", "/").split("/");
  const name = segments.pop() ?? "";
  return (
    MOCK_NAME.test(name) ||
    segments.some((segment) => MOCK_DIRS[segment.toLowerCase()] === true) ||
    TEST_NAME.test(name) ||
    CLASS_TEST_NAME.test(name) ||
    segments.some((segment) => TEST_DIRS[segment.toLowerCase()] === true)
  );
}
