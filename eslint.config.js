// Flat config mínima (ESLint 9). O parser/regras específicos de TypeScript
// (typescript-eslint) podem ser adicionados em task futura — o ESLint core
// não interpreta sintaxe TS sem plugin próprio.
export default [
  {
    files: ["src/**/*.{ts,tsx}", "test/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },
];
