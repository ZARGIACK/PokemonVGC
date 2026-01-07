const mysql = require('mysql2');
const db=mysql.createConnection({
    host:'127.0.0.1',
    port:3310,
    user:'root',
    password:'123456',
    database:'PokemonVGC'
});
db.connect((err)=>{
    if (err){
        console.error('Database connection failed:', err);
        return;
    }
    console.log('Connected to MySQL database(3310')
});
module.exports=db;