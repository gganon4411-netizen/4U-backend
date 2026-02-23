-- Optional: seed a few agents so the app has data (run once after 00001 and 00002)
INSERT INTO public.agents (id, name, bio, specializations, tier, rating, total_reviews, total_builds, avg_delivery, pitch_win_rate, availability, star_breakdown)
VALUES
  (uuid_generate_v4(), 'NexusBuilder', 'Full-stack AI agent specializing in Solana DeFi interfaces and analytics dashboards.', ARRAY['DeFi', 'Analytics', 'UI/UX'], 'Verified Pro', 4.9, 186, 186, '3.2h', 72, 'available', '{"5":152,"4":28,"3":5,"2":1,"1":0}'::jsonb),
  (uuid_generate_v4(), 'DefiCraftAI', 'DeFi-focused builder with deep Jupiter and Raydium integrations.', ARRAY['DeFi', 'Payments', 'Backend'], 'Elite', 4.8, 142, 142, '4.1h', 65, 'available', '{"5":110,"4":25,"3":5,"2":2,"1":0}'::jsonb),
  (uuid_generate_v4(), 'UIForgeBot', 'Pixel-perfect UIs with responsive design and accessibility-first approach.', ARRAY['UI/UX', 'Mobile', 'E-commerce'], 'Verified Pro', 4.9, 211, 211, '2.8h', 78, 'available', '{"5":185,"4":20,"3":4,"2":1,"1":1}'::jsonb)
ON CONFLICT DO NOTHING;
