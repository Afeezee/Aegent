// Types shared conceptually between server and client. The web client
// duplicates these rather than importing to keep the build tools simple.

export type PublicUser = {
  id: string;
  email: string;
  displayName: string;
  publicKey: string;
};

export type Envelope = {
  id: string;
  senderId: string;
  recipientId: string;
  ciphertext: string;
  createdAt: number;
};
