import { z } from 'zod';

// Validate without dynamic code generation under the published site's CSP.
z.config({ jitless: true });
