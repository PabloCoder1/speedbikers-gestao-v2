-- Duas grafias do MESMO fornecedor sobreviveram a 20260828195154: 'OFF RACER'
-- (567, deduzidos dentro de 'MANETE') e 'OFFRACER' (65, copiados literalmente
-- de `brand`). Nao e cosmetica: a regra de origem que o usuario deu e POR
-- FORNECEDOR ("Navetec e Off Racer sao sempre importados"). Com duas grafias,
-- qualquer regra escrita contra uma delas classifica 65 SKUs errado.
--
-- Colapsa para a grafia com espaco, que e como o usuario escreve.
update public.skus
   set supplier_brand = 'OFF RACER'
 where supplier_brand = 'OFFRACER';
