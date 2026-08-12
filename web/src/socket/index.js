import { io } from 'socket.io-client';
import { BASE_URL } from '../env';

export const socket = io(BASE_URL, { transports: ['websocket', 'polling'] });

export const connectSocket = () => socket.connect();
export const disconnectSocket = () => socket.disconnect();
