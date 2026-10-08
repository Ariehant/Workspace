import nodemailer from 'nodemailer';
import type { Config } from './config';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** Sends email (invites). Tests use their own. */
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** The SMTP mailer for the config, or null when no mail server is set up. */
export function smtpMailer(config: Config): Mailer | null {
  if (!config.smtp) return null;
  const transport = nodemailer.createTransport(config.smtp.url);
  const from = config.smtp.from;
  return {
    async send(mail) {
      await transport.sendMail({ from, ...mail });
    },
  };
}
