import { io } from 'socket.io-client';

export const socket = io();

export const connectSocket = () => socket.connect();
export const disconnectSocket = () => socket.disconnect();