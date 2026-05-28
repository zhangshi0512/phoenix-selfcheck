module.exports = {
  env: {
    commonjs: true,
    es2022: true,
    jest: true,
    node: true
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 2022
  },
  rules: {
    'no-console': 'off'
  }
};
