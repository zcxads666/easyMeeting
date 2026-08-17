import { io } from 'socket.io-client';
import { BASE_URL, API_TOKEN } from '../env';

export const socket = io(BASE_URL, {
  transports: ['websocket', 'polling'],
  auth: API_TOKEN ? { token: API_TOKEN } : undefined,
  query: API_TOKEN ? { token: API_TOKEN } : undefined
});

export const connectSocket = () => socket.connect();
export const disconnectSocket = () => socket.disconnect();
