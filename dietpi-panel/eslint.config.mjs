import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // Intentional modal form resets, localStorage client hydration, and full-page auth clears
      'react-hooks/set-state-in-effect': 'off',
      '@next/next/no-location-assign-relative-destination': 'off',
    },
  },
  {
    ignores: ['.next/**', 'node_modules/**'],
  },
];

export default eslintConfig;
