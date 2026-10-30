import tseslint from "typescript-eslint";

export default tseslint.config({ ignores: [".next/**"] }, tseslint.configs.recommended);
