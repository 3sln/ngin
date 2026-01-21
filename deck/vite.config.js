import {defineConfig} from 'vite';
import deck from '@3sln/deck/vite-plugin';

export default defineConfig({
  plugins: [deck()],
});
